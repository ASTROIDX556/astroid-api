import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { BudgetReservationService } from './services/budget-reservation.service';
import { PolicyEvaluatorService } from './services/policy-evaluator.service';
import { RedisLock } from '../../common/locks/redis-lock.util';
import { RollingWindowBudgetService } from './services/rolling-window-budget.service';
import { SpendingLimitGuardService } from './services/spending-limit-guard.service';

/**
 * Budget module. Exports the service so the transactions pipeline can enforce
 * spend limits (reserve) and record realised spend (consume / release).
 * BudgetReservationService provides the distributed-lock + atomic reservation
 * that prevents concurrent agent requests from overspending a budget.
 * Also provides the PolicyEvaluatorService for combined policy + budget
 * evaluation, and RollingWindowBudgetService for configurable rolling-window
 * spend checks (distinct from the fixed-period Budget counter).
 *
 * RedisLock is provided globally by the LocksModule.
 */
@Module({
  controllers: [BudgetController],
  providers: [BudgetService, BudgetRepository, PolicyEvaluatorService, RollingWindowBudgetService, SpendingLimitGuardService],
  exports: [BudgetService, PolicyEvaluatorService, RollingWindowBudgetService, SpendingLimitGuardService],
})
export class BudgetModule {}
