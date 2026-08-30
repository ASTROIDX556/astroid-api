import { Injectable } from '@nestjs/common';
import { Budget, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/** A Prisma client capable of running budget queries: the singleton service or an interactive-transaction handle. */
type BudgetQueryClient = Pick<PrismaService, 'budget'> | Prisma.TransactionClient;

/** Persistence for Budget rows, including atomic spend increments. */
@Injectable()
export class BudgetRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.BudgetCreateInput): Promise<Budget> {
    return this.prisma.budget.create({ data });
  }

  async findManyAndCount(where: Prisma.BudgetWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.budget.findMany({ where, ...pagination }),
      this.prisma.budget.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string): Promise<Budget | null> {
    return this.prisma.budget.findFirst({ where: { id, organizationId, deletedAt: null } });
  }

  findChildren(parentBudgetId: string): Promise<Budget[]> {
    return this.prisma.budget.findMany({
      where: { parentBudgetId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  update(id: string, data: Prisma.BudgetUpdateInput): Promise<Budget> {
    return this.prisma.budget.update({ where: { id }, data });
  }

  /** Atomically increments `spent` by `amount` (positive) — used on consume. */
  incrementSpent(id: string, amount: Prisma.Decimal): Promise<Budget> {
    return this.prisma.budget.update({
      where: { id },
      data: { spent: { increment: amount } },
    });
  }

  softDelete(id: string): Promise<Budget> {
    return this.prisma.budget.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
  }

  /**
   * All enabled, non-deleted budgets configured directly for an agent — used
   * by the rolling-window budget check. Accepts an optional transaction
   * client so callers running inside a Prisma interactive transaction (e.g.
   * `RollingWindowBudgetService`) can read a consistent snapshot alongside
   * their spend aggregate; defaults to the singleton client otherwise.
   */
  findEnabledByAgentId(agentId: string, client: BudgetQueryClient = this.prisma): Promise<Budget[]> {
    return client.budget.findMany({
      where: { agentId, enabled: true, deletedAt: null },
    });
  }
}
