import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { PolicyEvaluatorService } from './services/policy-evaluator.service';
import { SpendingLimitGuardService } from './services/spending-limit-guard.service';
import { RedisLock } from '../../common/locks/redis-lock.util';

/**
 * Budget module. Exports the service so the transactions pipeline can enforce
 * spend limits (assertWithinBudget) and record realised spend (consume).
 * Also provides the PolicyEvaluatorService for combined policy + budget
 * evaluation and SpendingLimitGuardService for distributed locking.
 */
@Module({
  controllers: [BudgetController],
  providers: [BudgetService, BudgetRepository, PolicyEvaluatorService, SpendingLimitGuardService, RedisLock],
  exports: [BudgetService, PolicyEvaluatorService, SpendingLimitGuardService],
})
export class BudgetModule {}
