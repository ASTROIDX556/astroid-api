import { Injectable } from '@nestjs/common';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { BudgetService } from '../budget.service';

/**
 * Wraps the budget check + consume cycle in a single Redis distributed lock
 * to eliminate the TOCTOU race between assertWithinBudget (step 5) and
 * consume (step 7) in the transaction pipeline.
 *
 * Without this guard, concurrent transactions can both pass the headroom
 * check before either consumes, overshooting the budget limit.
 *
 * The lock key is `lock:budget:guard:{budgetId}` — distinct from the
 * individual check/consume keys in BudgetService.
 */
@Injectable()
export class SpendingLimitGuardService {
  constructor(
    private readonly redisLock: RedisLock,
    private readonly budgets: BudgetService,
  ) {}

  /**
   * Atomically validates headroom and debits the budget under a single
   * distributed lock. Throws BudgetExceededException if the spend would
   * breach the limit (no state is mutated in that case).
   *
   * @param organizationId - Owning organization.
   * @param budgetId - Budget to check and consume from.
   * @param amount - Amount to spend.
   * @param ttlMs - Lock TTL in milliseconds (default 5 000).
   * @returns The budget after consumption.
   */
  async guardAndConsume(
    organizationId: string,
    budgetId: string,
    amount: number,
    ttlMs = 5_000,
  ) {
    const lockKey = `budget:guard:${budgetId}`;
    return this.redisLock.withLock(
      lockKey,
      async () => {
        // Step 1: Validate headroom (same logic as assertWithinBudget).
        await this.budgets.assertWithinBudget(organizationId, budgetId, amount);

        // Step 2: Debit the budget (same logic as consume).
        return this.budgets.consume(organizationId, budgetId, amount);
      },
      ttlMs,
    );
  }
}
