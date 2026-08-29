import { Injectable } from '@nestjs/common';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { BudgetRepository } from '../budget.repository';
import { ConflictException } from '../../../common/exceptions/domain.exception';

/**
 * Service for budget reservation with distributed locking.
 * Prevents race conditions in concurrent budget operations.
 */
@Injectable()
export class BudgetReservationService {
  constructor(
    private readonly budgetRepository: BudgetRepository,
    private readonly redisLock: RedisLock,
  ) {}

  /**
   * Reserves a budget amount with distributed locking to prevent race conditions.
   * @param organizationId - Organization ID
   * @param budgetId - Budget ID to reserve from
   * @param amount - Amount to reserve
   * @returns The budget after reservation
   */
  async reserve(organizationId: string, budgetId: string, amount: number) {
    const lockKey = `budget:${budgetId}`;

    try {
      return await this.redisLock.withLock(lockKey, async () => {
        const budget = await this.budgetRepository.findById(organizationId, budgetId);
        if (!budget) {
          throw new ConflictException('Budget not found');
        }

        const currentSpent = Number(budget.spent);
        const newSpent = currentSpent + amount;
        const limit = Number(budget.limitAmount);

        if (newSpent > limit) {
          throw new ConflictException('Budget limit exceeded due to concurrent operation');
        }

        return budget;
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }
      throw new ConflictException('Failed to acquire budget lock due to concurrent operation');
    }
  }
}
