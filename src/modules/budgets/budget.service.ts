import { Injectable } from '@nestjs/common';
import { Budget, Prisma } from '@prisma/client';
import { BudgetRepository } from './budget.repository';
import { BudgetReservationService } from './services/budget-reservation.service';
import { AllocateBudgetInput, CreateBudgetInput, UpdateBudgetInput } from './budget.dto';
import {
  BudgetExceededException,
  ConflictException,
  NotFoundException,
} from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { RedisLock } from '../../common/locks/redis-lock.util';

const SORTABLE = ['createdAt', 'name', 'limitAmount', 'spent', 'period'];
const Decimal = Prisma.Decimal;

/** Remaining = limit − spent, never negative. */
function remaining(budget: Budget): Prisma.Decimal {
  const left = new Decimal(budget.limitAmount).minus(budget.spent);
  return left.isNegative() ? new Decimal(0) : left;
}

/**
 * Governs spend against hierarchical budgets (Org → Department → Project →
 * Agent). Amounts use Prisma.Decimal to preserve Stellar's 7-dp precision and
 * avoid floating-point drift. The transactions pipeline reserves the amount
 * against the budget before persisting a transaction (`reserve`), settles the
 * reservation after a successful payment (`consume`) and returns it when a
 * payment fails or is cancelled (`release`) — so concurrent agent requests can
 * never overspend a single budget.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly repository: BudgetRepository,
    private readonly eventBus: EventBusService,
    private readonly reservation: BudgetReservationService,
    private readonly redisLock: RedisLock,
  ) {}

  async create(organizationId: string, actorId: string, input: CreateBudgetInput): Promise<Budget> {
    if (input.parentBudgetId) {
      await this.getOrThrow(organizationId, input.parentBudgetId);
    }
    const budget = await this.repository.create({
      organization: { connect: { id: organizationId } },
      ...(input.parentBudgetId ? { parentBudget: { connect: { id: input.parentBudgetId } } } : {}),
      ...(input.agentId ? { agent: { connect: { id: input.agentId } } } : {}),
      name: input.name,
      currency: input.currency,
      limitAmount: new Decimal(input.limitAmount),
      period: input.period,
      rollover: input.rollover,
      enabled: input.enabled,
    });
    await this.eventBus.emit(
      DomainEventName.BudgetCreated,
      { budgetId: budget.id, name: budget.name, limitAmount: input.limitAmount },
      { organizationId, actorId, aggregateType: 'budget', aggregateId: budget.id },
    );
    return budget;
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.BudgetWhereInput = { organizationId, deletedAt: null };
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query.page, query.limit));
  }

  async getOrThrow(organizationId: string, id: string): Promise<Budget> {
    const budget = await this.repository.findById(organizationId, id);
    if (!budget) {
      throw new NotFoundException('Budget', id);
    }
    return budget;
  }

  /** Returns the budget with computed remaining balance and its direct children. */
  async getDetail(organizationId: string, id: string) {
    const budget = await this.getOrThrow(organizationId, id);
    const children = await this.repository.findChildren(id);
    return {
      ...budget,
      remaining: remaining(budget).toFixed(7),
      children: children.map((c) => ({ ...c, remaining: remaining(c).toFixed(7) })),
    };
  }

  async update(organizationId: string, actorId: string, id: string, input: UpdateBudgetInput) {
    await this.getOrThrow(organizationId, id);
    const data: Prisma.BudgetUpdateInput = {
      name: input.name,
      period: input.period,
      rollover: input.rollover,
      enabled: input.enabled,
    };
    if (input.limitAmount !== undefined) {
      data.limitAmount = new Decimal(input.limitAmount);
    }
    const budget = await this.repository.update(id, data);
    await this.eventBus.emit(
      DomainEventName.BudgetUpdated,
      { budgetId: id },
      { organizationId, actorId, aggregateType: 'budget', aggregateId: id },
    );
    return budget;
  }

  /**
   * Allocates part of a parent budget to a child by raising the child's limit.
   * Guards that the parent has enough unallocated headroom.
   */
  async allocate(
    organizationId: string,
    actorId: string,
    childId: string,
    input: AllocateBudgetInput,
  ) {
    // Acquire a distributed lock keyed on the parent budget to serialize
    // concurrent allocations from the same parent, preventing double-spend.
    const child = await this.getOrThrow(organizationId, childId);
    if (!child.parentBudgetId) {
      throw new ConflictException('Only a child budget can receive an allocation');
    }
    const parent = await this.getOrThrow(organizationId, child.parentBudgetId);
    const lockKey = `budget:${parent.id}`;
    const amount = new Decimal(input.amount);

    return this.redisLock.withLock(lockKey, async () => {
      // Re-read the parent inside the lock to get a fresh snapshot.
      const freshParent = await this.getOrThrow(organizationId, parent.id);
      if (amount.greaterThan(remaining(freshParent))) {
        throw new BudgetExceededException('Allocation exceeds the parent budget remaining balance', {
          parentRemaining: remaining(freshParent).toFixed(7),
          requested: amount.toFixed(7),
        });
      }
      const updated = await this.repository.update(childId, {
        limitAmount: new Decimal(child.limitAmount).plus(amount),
      });
      await this.eventBus.emit(
        DomainEventName.BudgetAllocated,
        { budgetId: childId, parentBudgetId: freshParent.id, amount: input.amount },
        { organizationId, actorId, aggregateType: 'budget', aggregateId: childId },
      );
      return updated;
    });
  }

  /**
   * Authoritative budget reservation used by the transactions pipeline. The
   * projected spend is checked against the limit and the reservation is
   * persisted atomically (spent is incremented) under a distributed lock, so
   * concurrent agent requests can never both pass the same headroom check.
   * Throws BudgetExceededException when the limit would be breached.
   */
  async reserve(organizationId: string, budgetId: string, amount: number) {
    // 404 for missing/deleted budgets before hitting the lock path.
    await this.getOrThrow(organizationId, budgetId);
    return this.reservation.reserve(organizationId, budgetId, amount);
  }

  /**
   * Settles a previously reserved amount after a payment completes. The spend
   * was already booked by {@link reserve}, so this only records the event and
   * emits warnings when utilisation nears the cap.
   */
  async consume(organizationId: string, budgetId: string, amount: number) {
    const budget = await this.getOrThrow(organizationId, budgetId);
    const utilisation = new Decimal(budget.spent).dividedBy(
      budget.limitAmount.isZero() ? new Decimal(1) : budget.limitAmount,
    );
    await this.eventBus.emit(
      DomainEventName.BudgetConsumed,
      { budgetId, amount, spent: budget.spent.toFixed(7) },
      { organizationId, aggregateType: 'budget', aggregateId: budgetId },
    );
    if (utilisation.greaterThanOrEqualTo(0.8)) {
      await this.eventBus.emit(
        DomainEventName.BudgetWarning,
        { budgetId, utilisation: utilisation.toFixed(4) },
        { organizationId, aggregateType: 'budget', aggregateId: budgetId },
      );
    }
    return budget;
  }

  /**
   * Returns previously reserved headroom when a payment fails or is cancelled.
   * Never drives spent below zero — release is clamped to the current spend.
   */
  async release(organizationId: string, budgetId: string, amount: number) {
    const budget = await this.getOrThrow(organizationId, budgetId);
    const decrement = new Decimal(amount);
    const clamped = decrement.greaterThan(budget.spent) ? new Decimal(budget.spent) : decrement;
    const updated = await this.repository.decrementSpent(budgetId, clamped);
    await this.eventBus.emit(
      DomainEventName.BudgetReleased,
      { budgetId, amount: clamped.toFixed(7) },
      { organizationId, aggregateType: 'budget', aggregateId: budgetId },
    );
    return updated;
  }

  async remove(organizationId: string, actorId: string, id: string) {
    await this.getOrThrow(organizationId, id);
    const children = await this.repository.findChildren(id);
    if (children.length > 0) {
      throw new ConflictException('Cannot delete a budget that has child budgets');
    }
    await this.repository.softDelete(id);
    await this.eventBus.emit(
      DomainEventName.BudgetUpdated,
      { budgetId: id, deleted: true },
      { organizationId, actorId, aggregateType: 'budget', aggregateId: id },
    );
    return { id, deleted: true };
  }
}

