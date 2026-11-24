import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Budget, BudgetPeriod, Prisma } from '@prisma/client';

import {
  BudgetAlertConfig,
  DEFAULT_BUDGET_ALERT_CONFIG,
} from '../../../config/budget-alert.config';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { BudgetAlertRepository } from '../budget-alert.repository';

const Decimal = Prisma.Decimal;

/**
 * Advances an anchor date by whole `period` units until the next period would
 * start in the future. `ONE_TIME` budgets never roll over, so their period
 * start is the anchor itself.
 *
 * Exported for tests: period rollover is what resets alert tracking.
 */
export function currentBudgetPeriodStart(
  period: BudgetPeriod,
  anchor: Date,
  now: Date = new Date(),
): Date {
  if (period === BudgetPeriod.ONE_TIME) return new Date(anchor.getTime());

  const start = new Date(anchor.getTime());
  let guard = 0;
  // Bounded so a corrupt anchor can never loop forever.
  while (guard < 10_000) {
    const next = advance(start, period);
    if (next.getTime() > now.getTime()) return start;
    start.setTime(next.getTime());
    guard += 1;
  }
  return start;
}

function advance(date: Date, period: BudgetPeriod): Date {
  const next = new Date(date.getTime());
  switch (period) {
    case BudgetPeriod.DAILY:
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    case BudgetPeriod.WEEKLY:
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case BudgetPeriod.MONTHLY:
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    case BudgetPeriod.QUARTERLY:
      next.setUTCMonth(next.getUTCMonth() + 3);
      return next;
    case BudgetPeriod.YEARLY:
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      return next;
    case BudgetPeriod.ONE_TIME:
    default:
      return next;
  }
}

/**
 * Evaluates budget usage against the configured percentage thresholds.
 *
 * Correctness properties:
 * - **At most once per threshold per period.** The alert is inserted into the
 *   `budget_alerts` ledger with a unique `(budgetId, periodStart, threshold)`
 *   constraint; only the caller that actually inserts emits the event. The
 *   insertion runs inside `BudgetService.consume`'s per-budget Redis lock, so
 *   concurrent spends cannot both win.
 * - **Period rollover resets tracking.** The period start is derived from the
 *   budget's anchor and its period, so a new period is a new ledger key.
 * - **Never breaks the spend.** Alert evaluation is best-effort: the spend has
 *   already been committed, so any failure is logged and swallowed.
 */
@Injectable()
export class BudgetAlertService {
  private readonly logger = new Logger(BudgetAlertService.name);

  constructor(
    private readonly alerts: BudgetAlertRepository,
    private readonly eventBus: EventBusService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** Resolved thresholds: per-budget override when set, global defaults otherwise. */
  thresholdsFor(budget: Pick<Budget, 'alertThresholds'>): number[] {
    const overrides = budget.alertThresholds ?? [];
    if (overrides.length > 0) {
      return Array.from(new Set(overrides)).sort((a, b) => a - b);
    }
    const configured =
      this.config?.get<BudgetAlertConfig>('budgetAlert') ?? DEFAULT_BUDGET_ALERT_CONFIG;
    return configured.thresholds;
  }

  /**
   * Emits one event for every threshold the current period usage has crossed
   * for the first time. Returns the thresholds newly alerted.
   */
  async evaluate(
    organizationId: string,
    budget: Budget,
    spentAfter: Prisma.Decimal,
    now: Date = new Date(),
  ): Promise<number[]> {
    try {
      const limit = new Decimal(budget.limitAmount);
      if (limit.lessThanOrEqualTo(0)) return [];

      const utilisation = new Decimal(spentAfter).dividedBy(limit).times(100);
      const thresholds = this.thresholdsFor(budget);
      if (thresholds.length === 0) return [];

      const periodStart = currentBudgetPeriodStart(budget.period, budget.periodStart, now);
      const emitted: number[] = [];

      for (const threshold of thresholds) {
        if (utilisation.lessThan(threshold)) continue;

        const inserted = await this.alerts.createIfAbsent({
          budgetId: budget.id,
          organizationId,
          periodStart,
          threshold,
          currency: budget.currency,
          usageAmount: new Decimal(spentAfter),
        });
        if (!inserted) continue;

        emitted.push(threshold);
        await this.emit(organizationId, budget, periodStart, threshold, spentAfter, limit, utilisation);
      }

      return emitted;
    } catch (error) {
      // The spend is already committed: alerting must never fail it.
      this.logger.warn(
        `Budget alert evaluation failed for budget ${budget.id}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  private async emit(
    organizationId: string,
    budget: Budget,
    periodStart: Date,
    threshold: number,
    usage: Prisma.Decimal,
    limit: Prisma.Decimal,
    utilisation: Prisma.Decimal,
  ): Promise<void> {
    await this.eventBus.emit(
      DomainEventName.BudgetThresholdReached,
      {
        budgetId: budget.id,
        period: budget.period,
        periodStart: periodStart.toISOString(),
        threshold,
        usage: usage.toFixed(7),
        limit: limit.toFixed(7),
        utilisation: utilisation.toFixed(2),
        currency: budget.currency,
      },
      { organizationId, aggregateType: 'budget', aggregateId: budget.id },
    );
  }
}
