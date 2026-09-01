import { Injectable, Logger } from '@nestjs/common';
import { BudgetPeriod, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';

/** Number of budgets to process per database transaction. */
const BATCH_SIZE = 500;

export interface ResetResult {
  totalReset: number;
  totalFailed: number;
  batchesProcessed: number;
}

/** Subset of Budget fields needed by the reset logic. */
export interface EligibleBudget {
  id: string;
  organizationId: string;
  name: string;
  period: BudgetPeriod;
  periodStart: Date;
  spent: Prisma.Decimal;
}

/**
 * Scans active budgets whose recurring period has elapsed and resets their
 * accumulated spend back to zero in batched, transactional chunks.
 *
 * Runs on a periodic schedule (see {@link BudgetResetWorker}) and is also
 * directly callable for manual / catch-up resets.
 */
@Injectable()
export class BudgetResetService {
  private readonly logger = new Logger(BudgetResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
  ) {}

  /**
   * Calculates the UTC date when a period that started at `start` will end.
   * ONE_TIME budgets never reset (returns a far-future sentinel).
   */
  calculatePeriodEnd(start: Date, period: BudgetPeriod): Date {
    const end = new Date(start);
    switch (period) {
      case BudgetPeriod.DAILY:
        end.setUTCDate(end.getUTCDate() + 1);
        break;
      case BudgetPeriod.WEEKLY:
        end.setUTCDate(end.getUTCDate() + 7);
        break;
      case BudgetPeriod.MONTHLY:
        end.setUTCMonth(end.getUTCMonth() + 1);
        break;
      case BudgetPeriod.QUARTERLY:
        end.setUTCMonth(end.getUTCMonth() + 3);
        break;
      case BudgetPeriod.YEARLY:
        end.setUTCFullYear(end.getUTCFullYear() + 1);
        break;
      case BudgetPeriod.ONE_TIME:
        return new Date('9999-12-31T23:59:59.999Z');
    }
    return end;
  }

  /**
   * Main entry point. Finds all enabled, non-deleted, recurring budgets whose
   * period has elapsed and resets their `spent` to 0 while advancing
   * `periodStart` to `now`.  Uses cursor-based pagination so only a bounded
   * number of rows are held in memory at any time.
   */
  async runReset(now: Date = new Date()): Promise<ResetResult> {
    const result: ResetResult = {
      totalReset: 0,
      totalFailed: 0,
      batchesProcessed: 0,
    };

    let cursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const budgets = await this.fetchBatch(cursor);

      if (budgets.length === 0) break;

      // Filter to only those whose period has actually elapsed.
      const eligible = budgets.filter((b) => {
        const periodEnd = this.calculatePeriodEnd(b.periodStart, b.period);
        return periodEnd <= now;
      });

      if (eligible.length > 0) {
        await this.processBatch(eligible, now, result);
      }

      cursor = budgets[budgets.length - 1]!.id;

      // Last page – nothing more to fetch.
      if (budgets.length < BATCH_SIZE) break;
    }

    this.logger.log(
      `Budget period reset completed: ${result.totalReset} reset, ` +
        `${result.totalFailed} failed across ${result.batchesProcessed} batch(es)`,
    );

    return result;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /** Fetches the next page of candidate budgets using cursor pagination. */
  private async fetchBatch(cursor?: string): Promise<EligibleBudget[]> {
    return this.prisma.budget.findMany({
      where: {
        deletedAt: null,
        enabled: true,
        period: { not: BudgetPeriod.ONE_TIME },
      },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        organizationId: true,
        name: true,
        period: true,
        periodStart: true,
        spent: true,
      },
    });
  }

  /**
   * Resets a single batch of eligible budgets inside a Prisma transaction.
   * Uses `updateMany` to avoid row-level locks and minimise round-trips.
   */
  private async processBatch(
    budgets: EligibleBudget[],
    now: Date,
    result: ResetResult,
  ): Promise<void> {
    const ids = budgets.map((b) => b.id);

    try {
      await this.prisma.$transaction(async (tx) => {
        const updateResult = await tx.budget.updateMany({
          where: {
            id: { in: ids },
            deletedAt: null,
            enabled: true,
          },
          data: {
            spent: new Prisma.Decimal(0),
            periodStart: now,
          },
        });

        result.totalReset += updateResult.count;
        result.batchesProcessed++;

        // Emit a domain event per reset budget so the audit listener and
        // analytics pipelines can react.
        for (const budget of budgets) {
          await this.eventBus.emit(
            DomainEventName.BudgetPeriodReset,
            {
              budgetId: budget.id,
              previousSpent: budget.spent.toFixed(7),
              resetAt: now.toISOString(),
              period: budget.period,
            },
            {
              organizationId: budget.organizationId,
              aggregateType: 'budget',
              aggregateId: budget.id,
            },
          );
        }
      });
    } catch (error) {
      result.totalFailed += ids.length;
      this.logger.error(
        `Batch reset failed for ${ids.length} budgets: ${(error as Error).message}`,
      );
    }
  }
}
