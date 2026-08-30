import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { PolicyEvaluatorService } from './services/policy-evaluator.service';
import { RollingWindowBudgetService } from './services/rolling-window-budget.service';
import { RedisLock } from '../../common/locks/redis-lock.util';

/**
 * Budget module. Exports the service so the transactions pipeline can enforce
 * spend limits (assertWithinBudget) and record realised spend (consume).
 * Also provides the PolicyEvaluatorService for combined policy + budget
 * evaluation, and RollingWindowBudgetService for configurable rolling-window
 * spend checks (distinct from the fixed-period Budget counter).
 */
@Module({
  controllers: [BudgetController],
  providers: [BudgetService, BudgetRepository, PolicyEvaluatorService, RollingWindowBudgetService, RedisLock],
  exports: [BudgetService, PolicyEvaluatorService, RollingWindowBudgetService],
})
export class BudgetModule {}
