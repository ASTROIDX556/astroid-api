import { Injectable } from '@nestjs/common';
import { BudgetAlert, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Persistence for the `budget_alerts` threshold ledger. */
@Injectable()
export class BudgetAlertRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserts an alert row unless one already exists for this
   * `(budget, periodStart, threshold)`. Returns true only when this call
   * performed the insert, i.e. this is the first time the threshold was crossed
   * in the period.
   */
  async createIfAbsent(data: {
    budgetId: string;
    organizationId: string;
    periodStart: Date;
    threshold: number;
    currency: string;
    usageAmount: Prisma.Decimal;
  }): Promise<boolean> {
    try {
      await this.prisma.budgetAlert.create({ data });
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  findById(id: string): Promise<BudgetAlert | null> {
    return this.prisma.budgetAlert.findUnique({ where: { id } });
  }

  /** The ledger row of one threshold in one budget period, when it exists. */
  findByPeriod(
    budgetId: string,
    periodStart: Date,
    threshold: number,
  ): Promise<BudgetAlert | null> {
    return this.prisma.budgetAlert.findUnique({
      where: {
        budgetId_periodStart_threshold: { budgetId, periodStart, threshold },
      },
    });
  }

  /** Atomically claims the notification job for the alert, if not yet claimed. */
  async markNotified(id: string, notifiedAt: Date = new Date()): Promise<boolean> {
    const result = await this.prisma.budgetAlert.updateMany({
      where: { id, notifiedAt: null },
      data: { notifiedAt },
    });
    return result.count > 0;
  }

  findPending(limit = 100): Promise<BudgetAlert[]> {
    return this.prisma.budgetAlert.findMany({
      where: { notifiedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}
