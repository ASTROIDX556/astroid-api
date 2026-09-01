import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { BudgetRepository } from '../budget.repository';
import {
  BudgetExceededException,
  ConflictException,
  DomainException,
} from '../../../common/exceptions/domain.exception';

const Decimal = Prisma.Decimal;

/**
 * Service for budget reservation with distributed locking.
 * Prevents race conditions in concurrent budget operations: the reservation is
 * persisted atomically (`spent += amount`) while holding the lock, so two
 * concurrent agent requests can never both pass the same headroom check.
 */
@Injectable()
export class BudgetReservationService {
  constructor(
    private readonly budgetRepository: BudgetRepository,
    private readonly redisLock: RedisLock,
  ) {}

  /**
   * Reserves `amount` against a budget under a distributed lock. The projected
   * spend is checked against the limit and, when within budget, the reservation
   * is persisted immediately (spent is incremented) so later reservations see
   * it. Throws `BudgetExceededException` when the limit would be breached and
   * `ConflictException` when the budget is missing or the lock cannot be
   * acquired.
   *
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

        const projected = new Decimal(budget.spent).plus(amount);
        if (projected.greaterThan(budget.limitAmount)) {
          throw new BudgetExceededException('Transaction would exceed the budget limit', {
            budgetId,
            limit: budget.limitAmount.toFixed(7),
            spent: budget.spent.toFixed(7),
            attempted: amount,
          });
        }

        // Persist the reservation atomically — the check and the increment are
        // serialized by the lock, so concurrent requests cannot overspend.
        return this.budgetRepository.incrementSpent(budgetId, new Decimal(amount));
      });
    } catch (error) {
      if (error instanceof DomainException) {
        throw error;
      }
      throw new ConflictException('Failed to acquire budget lock due to concurrent operation');
    }
  }
}
