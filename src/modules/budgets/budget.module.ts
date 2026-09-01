import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { PolicyEvaluatorService } from './services/policy-evaluator.service';
import { RollingWindowBudgetService } from './services/rolling-window-budget.service';

/**
 * Budget module. Exports the service so the transactions pipeline can enforce
 * spend limits (assertWithinBudget) and record realised spend (consume).
 * Also provides the PolicyEvaluatorService for combined policy + budget
 * evaluation, and RollingWindowBudgetService for configurable rolling-window
 * spend checks (distinct from the fixed-period Budget counter).
 *
 * RedisLock is provided globally by the LocksModule.
 */
@Module({
  controllers: [BudgetController],
  providers: [BudgetService, BudgetRepository, PolicyEvaluatorService, RollingWindowBudgetService],
  exports: [BudgetService, PolicyEvaluatorService, RollingWindowBudgetService],
})
export class BudgetModule {}
