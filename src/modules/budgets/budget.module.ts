import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { BudgetReservationService } from './services/budget-reservation.service';
import { RedisLock } from '../../common/locks/redis-lock.util';

/**
 * Budget module. Exports the service so the transactions pipeline can enforce
 * spend limits (assertWithinBudget) and record realised spend (consume).
 */
@Module({
  controllers: [BudgetController],
  providers: [BudgetService, BudgetRepository, BudgetReservationService, RedisLock],
  exports: [BudgetService, BudgetReservationService],
})
export class BudgetModule {}
