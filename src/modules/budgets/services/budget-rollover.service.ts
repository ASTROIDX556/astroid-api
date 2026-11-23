import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Budget, Prisma } from '@prisma/client';
import {
  DEFAULT_BUDGET_ROLLOVER_CONFIG,
  BudgetRolloverConfig,
} from '../../../config/budget-rollover.config';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { PrismaTransactionService } from '../../../database/prisma-transaction.service';
import { BudgetPeriodRepository } from '../budget-period.repository';
import { computeCarryOver, getNthPeriodBounds } from '../utils/period.util';

const Decimal = Prisma.Decimal;
const MAX_PERIODS_PER_BUDGET = 1_000;

export type BudgetRolloverOutcome = 'rolled_over' | 'already' | 'skipped' | 'failed';

export interface BudgetRolloverSummary {
  scanned: number;
  batches: number;
  rolledOver: number;
  already: number;
  skipped: number;
  failed: number;
  periodsClosed: number;
}

interface RolloverResult {
  outcome: Exclude<BudgetRolloverOutcome, 'failed'>;
  periodsClosed: number;
  event?: {
    organizationId: string;
    closedPeriodStart: Date;
    closedPeriodEnd: Date;
    periodStart: Date;
    periodEnd: Date;
    spent: Prisma.Decimal;
    carry: Prisma.Decimal;
    rule: Budget['carryOverRule'];
    timezone: string;
    currency: string;
  };
}

/**
 * Closes elapsed budget periods and opens the next one.
 *
 * One database transaction per budget keeps the period rows, the budget's
 * current window and its spend counter consistent. Budgets are read in id-ordered
 * pages, so a large fleet never occupies more than `batchSize` rows at once and
 * a crash leaves only the unprocessed tail for the next scheduled tick.
 */
@Injectable()
export class BudgetRolloverService {
  private readonly logger = new Logger(BudgetRolloverService.name);

  constructor(
    private readonly periods: BudgetPeriodRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly eventBus: EventBusService,
    private readonly config: ConfigService,
  ) {}

  private settings(): BudgetRolloverConfig {
    return this.config.get<BudgetRolloverConfig>('budgetRollover') ?? DEFAULT_BUDGET_ROLLOVER_CONFIG;
  }

  /** Rolls over every expired budget, one bounded page at a time. */
  async rolloverExpired(now: Date = new Date(), batchSizeOverride?: number): Promise<BudgetRolloverSummary> {
    const settings = this.settings();
    const batchSize = Math.max(1, batchSizeOverride ?? settings.batchSize);
    const maxBatches = Math.max(1, settings.maxBatches);
    const summary: BudgetRolloverSummary = {
      scanned: 0,
      batches: 0,
      rolledOver: 0,
      already: 0,
      skipped: 0,
      failed: 0,
      periodsClosed: 0,
    };

    let cursorId: string | undefined;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const page = await this.periods.findExpired(now, batchSize, cursorId);
      if (page.length === 0) break;
      summary.batches += 1;
      summary.scanned += page.length;

      for (const budget of page) {
        try {
          const result = await this.rolloverBudget(budget.id, now);
          if (result.outcome === 'rolled_over') summary.rolledOver += 1;
          if (result.outcome === 'already') summary.already += 1;
          if (result.outcome === 'skipped') summary.skipped += 1;
          summary.periodsClosed += result.periodsClosed;
        } catch (error) {
          summary.failed += 1;
          this.logger.error(
            `Budget rollover failed for ${budget.id}: ${(error as Error).message}`,
          );
        }
      }

      cursorId = page[page.length - 1].id;
      if (page.length < batchSize) break;
    }

    this.logger.log(
      `Budget rollover finished: ${summary.scanned} scanned, ${summary.rolledOver} rolled over, ` +
        `${summary.periodsClosed} periods closed, ${summary.already} already current, ` +
        `${summary.skipped} skipped, ${summary.failed} failed (${summary.batches} batches)`,
    );
    return summary;
  }

  /** Rolls over a single budget. Exported for direct worker/manual use. */
  async rolloverBudget(budgetId: string, now: Date = new Date()): Promise<RolloverResult> {
    const committed = await this.transactions.run(
      async (tx) => {
        const budget = await this.periods.lockBudget(tx, budgetId);
        if (
          !budget ||
          !budget.enabled ||
          budget.deletedAt ||
          budget.period === 'ONE_TIME' ||
          !budget.periodEnd
        ) {
          return { outcome: 'skipped', periodsClosed: 0 } satisfies RolloverResult;
        }

        const timezone = budget.timezone || 'UTC';
        const anchor = budget.periodAnchor ?? budget.periodStart;
        let index = budget.periodIndex ?? 0;
        let spent = new Decimal(budget.spent);
        let periodsClosed = 0;
        let alreadyRolledOver = false;
        let event: RolloverResult['event'];

        for (let guard = 0; guard < MAX_PERIODS_PER_BUDGET; guard += 1) {
          const bounds = getNthPeriodBounds(budget.period, anchor, timezone, index);
          if (bounds.end.getTime() > now.getTime()) {
            // The period configuration changed while the job was away: keep
            // the stored boundaries aligned without opening a spurious period.
            if (
              budget.periodStart.getTime() !== bounds.start.getTime() ||
              !budget.periodEnd ||
              budget.periodEnd.getTime() !== bounds.end.getTime()
            ) {
              await this.periods.syncCurrentPeriod(tx, budget.id, {
                periodStart: bounds.start,
                periodEnd: bounds.end,
              });
            }
            break;
          }

          const next = getNthPeriodBounds(budget.period, anchor, timezone, index + 1);
          const carry = computeCarryOver(budget.carryOverRule, budget.limitAmount, spent);
          const closedAt = new Date();

          await this.periods.closePeriod(tx, {
            budgetId: budget.id,
            organizationId: budget.organizationId,
            periodStart: bounds.start,
            periodEnd: bounds.end,
            finalSpent: spent,
            carryOverRule: budget.carryOverRule,
            closedAt,
          });

          const opened = await this.periods.openPeriod(tx, {
            budgetId: budget.id,
            organizationId: budget.organizationId,
            periodStart: next.start,
            periodEnd: next.end,
            openingBalance: carry,
            carryOverRule: budget.carryOverRule,
          });
          const openingBalance = opened.created ? carry : new Decimal(opened.record.openingBalance);

          if (
            !opened.created &&
            budget.periodStart.getTime() === next.start.getTime() &&
            next.end.getTime() > now.getTime()
          ) {
            alreadyRolledOver = true;
            break;
          }

          await this.periods.updateCurrentPeriod(tx, budget.id, {
            periodStart: next.start,
            periodEnd: next.end,
            spent: openingBalance,
            periodIndex: index + 1,
          });

          periodsClosed += 1;
          event = {
            organizationId: budget.organizationId,
            closedPeriodStart: bounds.start,
            closedPeriodEnd: bounds.end,
            periodStart: next.start,
            periodEnd: next.end,
            spent,
            carry: openingBalance,
            rule: budget.carryOverRule,
            timezone,
            currency: budget.currency,
          };

          index += 1;
          spent = openingBalance;
        }

        if (periodsClosed === 0 || !event) {
          return {
            outcome: alreadyRolledOver ? 'already' : 'skipped',
            periodsClosed: 0,
          } satisfies RolloverResult;
        }
        return { outcome: 'rolled_over', periodsClosed, event } satisfies RolloverResult;
      },
      { name: 'budget.period_rollover' },
    );

    if (committed.outcome === 'rolled_over' && committed.event) {
      const event = committed.event;
      try {
        await this.eventBus.emit(
          DomainEventName.BudgetPeriodRollover,
          {
            budgetId,
            organizationId: event.organizationId,
            closedPeriodStart: event.closedPeriodStart.toISOString(),
            closedPeriodEnd: event.closedPeriodEnd.toISOString(),
            spent: event.spent.toFixed(7),
            periodStart: event.periodStart.toISOString(),
            periodEnd: event.periodEnd.toISOString(),
            carryOverAmount: event.carry.toFixed(7),
            carryOverRule: event.rule,
            timezone: event.timezone,
            currency: event.currency,
            periodsClosed: committed.periodsClosed,
          },
          {
            organizationId: event.organizationId,
            aggregateType: 'budget',
            aggregateId: budgetId,
          },
        );
      } catch (error) {
        this.logger.warn(
          `Could not emit budget rollover event for ${budgetId}: ${(error as Error).message}`,
        );
      }
    }

    return { outcome: committed.outcome, periodsClosed: committed.periodsClosed };
  }
}
