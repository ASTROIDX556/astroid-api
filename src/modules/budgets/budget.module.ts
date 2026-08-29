import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { BudgetReservationService } from './services/budget-reservation.service';
import { PolicyEvaluatorService } from './services/policy-evaluator.service';
import { RedisLock } from '../../common/locks/redis-lock.util';

/**
 * Budget module. Exports the service so the transactions pipeline can enforce
 * spend limits (reserve) and record realised spend (consume / release).
 * BudgetReservationService provides the distributed-lock + atomic reservation
 * that prevents concurrent agent requests from overspending a budget.
 * Also provides the PolicyEvaluatorService for combined policy + budget
 * evaluation.
 */
@Module({
  controllers: [BudgetController],
  providers: [
    BudgetService,
    BudgetRepository,
    BudgetReservationService,
    RedisLock,
    PolicyEvaluatorService,
  ],
  exports: [BudgetService, PolicyEvaluatorService],
})
export class BudgetModule {}
