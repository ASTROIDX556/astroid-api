import { Injectable, Optional } from '@nestjs/common';
import { Budget, BudgetPeriod, BudgetReservation, Prisma } from '@prisma/client';
import { BudgetRepository, BudgetReservationError } from './budget.repository';
import { AllocateBudgetInput, CreateBudgetInput, UpdateBudgetInput } from './budget.dto';
import {
  BudgetExceededException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationException,
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
import { BudgetAlertService } from './services/budget-alert.service';
import { BudgetRolloverService } from './services/budget-rollover.service';
import { getPeriodBounds } from './utils/period.util';

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
 * avoid floating-point drift. The transactions pipeline takes an atomic
 * reservation (`reserveAtomic`) before executing, then `settle`s it after a
 * successful payment or `release`s it when the transaction is rejected, fails
 * or is cancelled.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly repository: BudgetRepository,
    private readonly eventBus: EventBusService,
    private readonly redisLock: RedisLock,
    private readonly rollover: BudgetRolloverService,
    @Optional() private readonly budgetAlerts?: BudgetAlertService,
  ) {}

  async create(organizationId: string, actorId: string, input: CreateBudgetInput): Promise<Budget> {
    if (input.parentBudgetId) {
      await this.getOrThrow(organizationId, input.parentBudgetId);
    }
    const periodStart = input.periodStart ?? new Date();
    const bounds = getPeriodBounds(input.period, periodStart, input.timezone);
    const budget = await this.repository.create({
      organization: { connect: { id: organizationId } },
      ...(input.parentBudgetId ? { parentBudget: { connect: { id: input.parentBudgetId } } } : {}),
      ...(input.agentId ? { agent: { connect: { id: input.agentId } } } : {}),
      name: input.name,
      currency: input.currency,
      limitAmount: new Decimal(input.limitAmount),
      period: input.period,
      periodStart,
      periodEnd: input.period === BudgetPeriod.ONE_TIME ? null : bounds.end,
      periodAnchor: periodStart,
      periodIndex: 0,
      timezone: input.timezone,
      carryOverRule: input.carryOverRule,
      rollover: input.rollover,
      enabled: input.enabled,
      ...(input.alertThresholds !== undefined ? { alertThresholds: input.alertThresholds } : {}),
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
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string): Promise<Budget> {
    const budget = await this.repository.findById(organizationId, id);
    if (!budget) {
      throw new NotFoundException('Budget', id);
    }
    return budget;
  }

  /**
   * Returns the budget with its balance breakdown and its direct children.
   *
   * - `spent`     – recorded spend plus held reservations (unchanged meaning:
   *                 a reservation counts against the limit as soon as it is made)
   * - `reserved`  – the part of `spent` held by PENDING reservations
   * - `available` – `limitAmount - spent`, floored at zero (same as `remaining`,
   *                 which is kept for existing clients)
   */
  async getDetail(organizationId: string, id: string) {
    const budget = await this.getOrThrow(organizationId, id);
    const children = await this.repository.findChildren(id);
    const reserved = await this.repository.sumPendingReservations([budget.id, ...children.map((c) => c.id)]);
    const balance = (b: Budget) => {
      const left = remaining(b).toFixed(7);
      return {
        remaining: left,
        available: left,
        reserved: (reserved.get(b.id) ?? new Decimal(0)).toFixed(7),
      };
    };
    return {
      ...budget,
      ...balance(budget),
      children: children.map((c) => ({ ...c, ...balance(c) })),
    };
  }

  async update(organizationId: string, actorId: string, id: string, input: UpdateBudgetInput) {
    const current = await this.getOrThrow(organizationId, id);
    const period = input.period ?? current.period;
    const timezone = input.timezone ?? (current.timezone || 'UTC');
    const data: Prisma.BudgetUpdateInput = {
      name: input.name,
      period: input.period,
      timezone: input.timezone,
      carryOverRule: input.carryOverRule,
      rollover: input.rollover,
      enabled: input.enabled,
    };
    if (input.period !== undefined || input.timezone !== undefined) {
      data.periodEnd =
        period === BudgetPeriod.ONE_TIME
          ? null
          : getPeriodBounds(period, current.periodStart, timezone).end;
      // A period-type/timezone change starts a fresh anchored sequence.
      data.periodAnchor = current.periodStart;
      data.periodIndex = 0;
    }
    if (input.limitAmount !== undefined) {
      data.limitAmount = new Decimal(input.limitAmount);
    }
    if (input.alertThresholds !== undefined) {
      data.alertThresholds = input.alertThresholds;
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

  /** Checks every active agent allocation against settled and in-flight spend. */
  async assertAgentBudgetWithinLimit(
    organizationId: string,
    agentId: string,
    asset: string,
    amount: number,
  ): Promise<void> {
    await this.redisLock.withLock(`agent-budget:${agentId}`, async () => {
      await this.checkAgentBudgetWithinLimit(organizationId, agentId, asset, amount);
    });
  }

  /** Keeps the budget check and transaction insert in one agent-scoped critical section. */
  async withAgentBudgetLimit<T>(
    organizationId: string,
    agentId: string,
    asset: string,
    amount: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.redisLock.withLock(`agent-budget:${agentId}`, async () => {
      await this.checkAgentBudgetWithinLimit(organizationId, agentId, asset, amount);
      return operation();
    });
  }

  private async checkAgentBudgetWithinLimit(
    organizationId: string,
    agentId: string,
    asset: string,
    amount: number,
  ): Promise<void> {
    const budgets = await this.repository.findEnabledByAgentId(
      agentId,
      undefined,
      organizationId,
    );
    const matchingBudgets = budgets.filter(
      (budget) => budget.currency.toUpperCase() === asset.toUpperCase(),
    );
    if (matchingBudgets.length === 0) return;

    const unaccountedSpend = await this.repository.sumUnaccountedSpendByAgent(
      agentId,
      organizationId,
      asset,
      matchingBudgets.map((budget) => budget.id),
    );
    for (const budget of matchingBudgets) {
      const projected = new Decimal(budget.spent).plus(unaccountedSpend).plus(amount);
      if (projected.greaterThan(budget.limitAmount)) {
        throw new ForbiddenException(
          `Transaction would exceed the active budget '${budget.name}'`,
        );
      }
    }
  }

  /**
   * Atomically reserves `amount` from the budget (see
   * {@link BudgetRepository.createReservation}): the limit check and the
   * increment are one conditional UPDATE, so concurrent callers — from any
   * worker, replica or agent — can never take the budget past its limit.
   *
   * A reservation always lands in the budget's current period. When the period
   * has ended but the scheduled rollover has not processed this budget yet, the
   * budget is rolled over first (idempotent, row-locked) and the reservation is
   * retried once, so spend made after the boundary is counted against the new
   * period instead of leaking into the closed one.
   *
   * @throws NotFoundException         – budget not found for the organisation
   * @throws BudgetExceededException   – reservation would exceed the limit
   * @throws ValidationException       – zero, negative or non-finite amount
   * @throws ConflictException         – the period has ended and the budget
   *                                     could not be rolled over (disabled)
   */
  async reserveAtomic(
    organizationId: string,
    budgetId: string,
    amount: number,
    now: Date = new Date(),
  ): Promise<BudgetReservation> {
    try {
      const reservation = await this.createReservationInCurrentPeriod(
        organizationId,
        budgetId,
        new Decimal(amount),
        now,
      );
      if (this.budgetAlerts) {
        const budget = await this.repository.findById(organizationId, budgetId);
        if (budget) {
          await this.budgetAlerts.evaluate(organizationId, budget, new Decimal(budget.spent)).catch(() => undefined);
        }
      }
      return reservation;
    } catch (error: unknown) {
      if (!(error instanceof BudgetReservationError)) throw error;
      if (error.reason === 'NotFoundException') throw new NotFoundException('Budget', budgetId);
      if (error.reason === 'InvalidAmount') {
        throw new ValidationException('Budget reservation amount must be greater than zero', {
          budgetId,
          attempted: amount,
        });
      }
      if (error.reason === 'BudgetPeriodElapsed') {
        throw new ConflictException(
          'The budget period has ended and the budget could not be rolled over to a new period',
          { budgetId },
        );
      }
      if (error.reason === 'BudgetExceeded') {
        const budget = await this.repository.findById(organizationId, budgetId).catch(() => null);
        await this.eventBus.emit(
          DomainEventName.BudgetExceeded,
          {
            budgetId,
            limit: budget?.limitAmount.toFixed(7) ?? '?',
            attempted: new Decimal(amount).toFixed(7),
          },
          { organizationId, aggregateType: 'budget', aggregateId: budgetId },
        );
        throw new BudgetExceededException('Transaction would exceed the budget limit', {
          budgetId,
          limit: budget?.limitAmount.toFixed(7) ?? '?',
          spent: budget?.spent.toFixed(7) ?? '?',
          attempted: amount,
        });
      }
      throw error;
    }
  }

  /**
   * Takes the reservation; if the budget's period has elapsed without being
   * rolled over, rolls it over and tries once more.
   */
  private async createReservationInCurrentPeriod(
    organizationId: string,
    budgetId: string,
    amount: Prisma.Decimal,
    now: Date,
  ): Promise<BudgetReservation> {
    try {
      return await this.repository.createReservation(organizationId, budgetId, amount, now);
    } catch (error: unknown) {
      if (!(error instanceof BudgetReservationError) || error.reason !== 'BudgetPeriodElapsed') {
        throw error;
      }
      await this.rollover.rolloverBudget(budgetId, now);
      return this.repository.createReservation(organizationId, budgetId, amount, now);
    }
  }

  /**
   * Settles a reservation after the payment completes. Adjusts `spent` by the
   * delta between the actual and reserved amounts, then marks the reservation
   * SETTLED. Idempotent — safe to call more than once.
   */
  async settle(
    organizationId: string,
    reservationId: string,
    actualAmount: number,
  ): Promise<BudgetReservation> {
    const reservation = await this.repository.settleReservation(
      reservationId,
      new Decimal(actualAmount),
    );
    const budget = await this.repository.findById(organizationId, reservation.budgetId);
    await this.eventBus.emit(
      DomainEventName.BudgetConsumed,
      {
        budgetId: reservation.budgetId,
        amount: actualAmount,
        spent: budget?.spent.toFixed(7) ?? '?',
      },
      { organizationId, aggregateType: 'budget', aggregateId: reservation.budgetId },
    );
    if (budget && this.budgetAlerts) {
      await this.budgetAlerts.evaluate(organizationId, budget, new Decimal(budget.spent)).catch(() => undefined);
    }
    return reservation;
  }

  /**
   * Releases a reservation after a failed or cancelled transaction, returning
   * the held amount to the budget's available balance. Idempotent — safe to
   * call more than once (guards against double-release).
   */
  async release(reservationId: string): Promise<BudgetReservation> {
    return this.repository.releaseReservation(reservationId);
  }

  async consume(organizationId: string, budgetId: string, amount: number) {
    // Serialize spend increments on the same budget to prevent concurrent
    // agents from overshooting the limit together.
    const lockKey = `budget:consume:${budgetId}`;
    return this.redisLock.withLock(lockKey, async () => {
      const budget = await this.repository.incrementSpent(budgetId, new Decimal(amount));
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
      // Threshold alerting is best-effort and never fails the committed spend.
      // The service swallows its own errors; the guard keeps a missing
      // dependency (unit tests, older wiring) from breaking consumption.
      if (this.budgetAlerts) {
        await this.budgetAlerts.evaluate(organizationId, budget, new Decimal(budget.spent));
      }
      return budget;
    });
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

