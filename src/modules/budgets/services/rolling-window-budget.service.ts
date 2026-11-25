import { Injectable } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { BudgetRepository } from '../budget.repository';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { BudgetExceededException } from '../../../common/exceptions/domain.exception';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';

const Decimal = Prisma.Decimal;

// ── Window-size helper constants (milliseconds) ──
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;
export const ONE_WEEK_MS = 7 * ONE_DAY_MS;

/**
 * Transaction statuses excluded from the "spent in window" sum. These are
 * terminal-failed states — the funds never left (or were returned to) the
 * wallet, so counting them against the agent's rolling budget would
 * needlessly throttle future spend. Every other status (including in-flight
 * ones like PENDING/APPROVED/SUBMITTED) is counted: an agent should not be
 * able to bypass the limit by racing several in-flight transactions before
 * any of them settle.
 */
const EXCLUDED_STATUSES: TransactionStatus[] = [
  TransactionStatus.FAILED,
  TransactionStatus.CANCELLED,
  TransactionStatus.REJECTED,
  TransactionStatus.EXPIRED,
];

export interface RollingWindowBudgetCheckResult {
  agentId: string;
  windowSizeMs: number;
  windowStart: Date;
  /** Sum of counted transaction amounts within the window, before this request. */
  spentInWindow: Prisma.Decimal;
  /** The applicable limit, or `null` when the agent has no configured budget. */
  limit: Prisma.Decimal | null;
  /** Remaining headroom after this request would be applied, or `null` when unlimited. */
  remainingAfter: Prisma.Decimal | null;
  /** id of the Budget row the limit was sourced from, if any. */
  budgetId?: string;
}

/**
 * Computes and enforces agent spending limits over a configurable rolling
 * time window (e.g. "no more than X in the trailing 24 hours"), derived from
 * real transaction history rather than a periodic counter.
 *
 * This is deliberately distinct from {@link BudgetService}, which enforces
 * fixed-period budgets (`Budget.period` + `Budget.spent`, reset per period).
 * A rolling window has no reset boundary — it always looks back exactly
 * `windowSizeMs` from "now" — so it cannot be modelled as a simple counter
 * and must be recomputed from the transaction ledger on every check.
 *
 * ## "Reserve" contract
 * There is no separate reservation table in the schema (out of scope for
 * this change), so `checkAndReserveBudget` does not itself write anything.
 * "Reserve" means: the caller MUST call this method, under its own lock and
 * transaction, immediately before creating the actual `Transaction` row that
 * represents the spend. Because the check and the row-creation are not the
 * same atomic operation, callers should create that row promptly after a
 * successful check (no unrelated awaits in between) so the window it is
 * about to add itself to reflects reality by the time any concurrent caller
 * re-aggregates.
 */
@Injectable()
export class RollingWindowBudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budgetRepository: BudgetRepository,
    private readonly redisLock: RedisLock,
    private readonly eventBus: EventBusService,
  ) {}

  /**
   * Atomically computes the agent's spend within the trailing `windowSizeMs`
   * window and checks whether `amount` would push it past the agent's
   * budget limit. Throws {@link BudgetExceededException} when it would.
   *
   * Race-condition safety has two layers:
   *   1. A Redis distributed lock (`agent-budget-window:<agentId>`) serialises
   *      concurrent checks for the same agent across all app instances, so two
   *      simultaneous requests cannot both read a stale sum and both pass.
   *   2. A Prisma interactive transaction ensures the spend aggregate and the
   *      budget lookup are read from a single consistent database snapshot.
   *
   * @param agentId - Agent whose spend is being checked.
   * @param amount - Proposed transaction amount (must be a finite, non-negative number).
   * @param windowSizeMs - Rolling window size in milliseconds (see ONE_HOUR_MS / ONE_DAY_MS / ONE_WEEK_MS).
   */
  async checkAndReserveBudget(
    agentId: string,
    amount: number,
    windowSizeMs: number,
  ): Promise<RollingWindowBudgetCheckResult> {
    const lockKey = `agent-budget-window:${agentId}`;

    return this.redisLock.withLock(lockKey, () =>
      this.prisma.$transaction(async (tx) => {
        const windowStart = new Date(Date.now() - windowSizeMs);
        const requested = new Decimal(amount);

        // Multiple enabled Budget rows can exist for one agent (e.g. created
        // by different admins, or a migration artifact). We treat the
        // *smallest* limitAmount among them as the effective ceiling — the
        // most conservative reading — rather than summing or picking
        // arbitrarily, so a misconfiguration can never silently grant more
        // headroom than intended.
        const budgets = await this.budgetRepository.findEnabledByAgentId(agentId, tx);
        const effectiveBudget = budgets.reduce<(typeof budgets)[number] | null>((tightest, candidate) => {
          if (!tightest) return candidate;
          return new Decimal(candidate.limitAmount).lessThan(tightest.limitAmount) ? candidate : tightest;
        }, null);

        const { _sum } = await tx.transaction.aggregate({
          where: {
            agentId,
            createdAt: { gte: windowStart },
            status: { notIn: EXCLUDED_STATUSES },
          },
          _sum: { amount: true },
        });
        const spentInWindow = _sum.amount ?? new Decimal(0);

        // No budget configured for this agent: rolling-window enforcement is
        // opt-in per agent, mirroring BudgetService (which only rejects when
        // a limit exists). Allow the spend and report an unlimited window.
        if (!effectiveBudget) {
          return {
            agentId,
            windowSizeMs,
            windowStart,
            spentInWindow,
            limit: null,
            remainingAfter: null,
          };
        }

        const limit = new Decimal(effectiveBudget.limitAmount);
        const projected = spentInWindow.plus(requested);

        if (projected.greaterThan(limit)) {
          await this.eventBus.emit(
            DomainEventName.BudgetExceeded,
            {
              budgetId: effectiveBudget.id,
              agentId,
              windowSizeMs,
              limit: limit.toFixed(7),
              spentInWindow: spentInWindow.toFixed(7),
              attempted: projected.toFixed(7),
            },
            {
              organizationId: effectiveBudget.organizationId,
              aggregateType: 'budget',
              aggregateId: effectiveBudget.id,
            },
          );
          throw new BudgetExceededException(
            'Transaction would exceed the rolling-window budget limit',
            {
              agentId,
              budgetId: effectiveBudget.id,
              windowSizeMs,
              limit: limit.toFixed(7),
              spentInWindow: spentInWindow.toFixed(7),
              attempted: requested.toFixed(7),
            },
          );
        }

        return {
          agentId,
          windowSizeMs,
          windowStart,
          spentInWindow,
          limit,
          remainingAfter: limit.minus(projected),
          budgetId: effectiveBudget.id,
        };
      }),
    );
  }
}
