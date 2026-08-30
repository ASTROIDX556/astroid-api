import { Injectable, Logger } from '@nestjs/common';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { BudgetRepository } from '../budget.repository';
import {
  ConflictException,
  BudgetExceededException,
} from '../../../common/exceptions/domain.exception';
import { Prisma } from '@prisma/client';

const Decimal = Prisma.Decimal;

/**
 * Distributed mutex guard for concurrent agent spending-limit evaluation.
 *
 * Wraps the check + consume cycle in a single Redis-backed lock so that two
 * concurrent transactions on the same budget cannot both pass the headroom
 * check before either one records its spend. This eliminates the TOCTOU race
 * between `assertWithinBudget` and `consume`.
 *
 * Lock keys follow the pattern `lock:budget:{budgetId}` with a configurable
 * TTL (default 5 s) to prevent deadlocks if a worker crashes mid-transaction.
 */
@Injectable()
export class SpendingLimitGuardService {
  private readonly logger = new Logger(SpendingLimitGuardService.name);

  constructor(
    private readonly budgetRepository: BudgetRepository,
    private readonly redisLock: RedisLock,
  ) {}

  /**
   * Atomically validates budget headroom AND records spend inside a single
   * distributed lock. Returns the updated budget on success.
   *
   * @param organizationId - owning org
   * @param budgetId       - budget to guard
   * @param amount         - amount about to be spent
   * @param ttl            - lock time-to-live in ms (default 5 000)
   */
  async guardAndConsume(
    organizationId: string,
    budgetId: string,
    amount: number,
    ttl: number = 5_000,
  ): Promise<unknown> {
    const lockKey = `budget:${budgetId}`;

    try {
      return await this.redisLock.withLock(
        lockKey,
        async () => {
          const budget = await this.budgetRepository.findById(
            organizationId,
            budgetId,
          );
          if (!budget) {
            throw new ConflictException('Budget not found');
          }

          const currentSpent = new Decimal(budget.spent);
          const limit = new Decimal(budget.limitAmount);
          const spendAfter = currentSpent.plus(amount);

          if (spendAfter.greaterThan(limit)) {
            throw new BudgetExceededException(
              'Transaction would exceed the budget limit',
              {
                budgetId,
                limit: limit.toFixed(7),
                spent: currentSpent.toFixed(7),
                attempted: amount,
              },
            );
          }

          // Atomically increment spent inside the lock
          const updated = await this.budgetRepository.incrementSpent(
            budgetId,
            new Decimal(amount),
          );

          return updated;
        },
        ttl,
      );
    } catch (error) {
      // Re-throw domain errors as-is
      if (
        error instanceof ConflictException ||
        error instanceof BudgetExceededException
      ) {
        throw error;
      }
      // Redis / infrastructure failure → conflict so the caller knows to retry
      this.logger.warn(
        `Failed to acquire budget lock for ${budgetId}: ${(error as Error).message}`,
      );
      throw new ConflictException(
        'Failed to acquire budget lock due to concurrent operation',
      );
    }
  }
}
