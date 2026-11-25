import { Injectable } from '@nestjs/common';
import {
  Budget,
  BudgetPeriod,
  BudgetPeriodRecord,
  BudgetPeriodStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface ClosePeriodInput {
  budgetId: string;
  organizationId: string;
  periodStart: Date;
  periodEnd: Date;
  finalSpent: Prisma.Decimal;
  carryOverRule: Budget['carryOverRule'];
  closedAt: Date;
}

export interface OpenPeriodInput {
  budgetId: string;
  organizationId: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: Prisma.Decimal;
  carryOverRule: Budget['carryOverRule'];
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
  );
}

/**
 * Persistence for the fixed-period history. Every writer takes a transactional
 * client so the period rows, the budget's current window and its spend counter
 * commit together. The unique (budgetId, periodStart) key is the idempotency
 * guard; a P2002 is treated as "already processed", never as a duplicate row.
 */
@Injectable()
export class BudgetPeriodRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** One page of expired budgets, ordered by id so cursor paging is stable. */
  findExpired(now: Date, batchSize: number, cursorId?: string): Promise<Budget[]> {
    return this.prisma.budget.findMany({
      where: {
        period: { not: BudgetPeriod.ONE_TIME },
        periodEnd: { not: null, lte: now },
        enabled: true,
        deletedAt: null,
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  }

  /** Locks the budget row so two replicas cannot roll it over concurrently. */
  async lockBudget(tx: Prisma.TransactionClient, id: string): Promise<Budget | null> {
    const rows = await tx.$queryRaw<Budget[]>`SELECT * FROM "budgets" WHERE id = ${id} FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** Closes a period, preserving its final spend even if the row already exists. */
  async closePeriod(tx: Prisma.TransactionClient, input: ClosePeriodInput): Promise<void> {
    try {
      await tx.budgetPeriodRecord.upsert({
        where: {
          budgetId_periodStart: {
            budgetId: input.budgetId,
            periodStart: input.periodStart,
          },
        },
        create: {
          budgetId: input.budgetId,
          organizationId: input.organizationId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          status: BudgetPeriodStatus.CLOSED,
          finalSpent: input.finalSpent,
          carryOverRule: input.carryOverRule,
          closedAt: input.closedAt,
        },
        update: {
          periodEnd: input.periodEnd,
          status: BudgetPeriodStatus.CLOSED,
          finalSpent: input.finalSpent,
          closedAt: input.closedAt,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent upsert won the race. The row already holds this snapshot.
    }
  }

  /**
   * Opens the next period. `created` is false when the unique key already
   * exists; the caller can then reuse the stored opening balance instead of
   * inserting a duplicate period.
   */
  async openPeriod(
    tx: Prisma.TransactionClient,
    input: OpenPeriodInput,
  ): Promise<{ record: BudgetPeriodRecord; created: boolean }> {
    try {
      const record = await tx.budgetPeriodRecord.create({
        data: {
          budgetId: input.budgetId,
          organizationId: input.organizationId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          status: BudgetPeriodStatus.OPEN,
          openingBalance: input.openingBalance,
          carryOverRule: input.carryOverRule,
        },
      });
      return { record, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const record = await tx.budgetPeriodRecord.findUnique({
        where: {
          budgetId_periodStart: {
            budgetId: input.budgetId,
            periodStart: input.periodStart,
          },
        },
      });
      if (!record) throw error;
      return { record, created: false };
    }
  }

  async syncCurrentPeriod(
    tx: Prisma.TransactionClient,
    id: string,
    data: { periodStart: Date; periodEnd: Date },
  ): Promise<void> {
    await tx.budget.update({ where: { id }, data });
  }

  async updateCurrentPeriod(
    tx: Prisma.TransactionClient,
    id: string,
    data: { periodStart: Date; periodEnd: Date; spent: Prisma.Decimal; periodIndex: number },
  ): Promise<void> {
    await tx.budget.update({ where: { id }, data });
  }
}
