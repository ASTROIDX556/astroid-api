import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { PolicyEvaluatorService } from './services/policy-evaluator.service';
import { RollingWindowBudgetService } from './services/rolling-window-budget.service';
import { AgentBudgetGuard } from './guards/agent-budget.guard';
import { BudgetAlertRepository } from './budget-alert.repository';
import { BudgetAlertService } from './services/budget-alert.service';
import { BudgetAlertWorker } from './workers/budget-alert.worker';
import { NotificationModule } from '../notifications/notification.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';

/**
 * Budget module. Exports the service so the transactions pipeline can enforce
 * spend limits (assertWithinBudget) and record realised spend (consume).
 * Also provides the PolicyEvaluatorService for combined policy + budget
 * evaluation, and RollingWindowBudgetService for configurable rolling-window
 * spend checks (distinct from the fixed-period Budget counter).
 *
 * RedisLock is provided globally by the LocksModule.
 *
 * Threshold alerts are emitted by `BudgetAlertService` from the spend path and
 * consumed asynchronously by `BudgetAlertWorker`, which turns them into in-app
 * notifications through the shared NotificationService.
 */
@Module({
  imports: [NotificationModule, IdempotencyModule],
  controllers: [BudgetController],
  providers: [
    BudgetService,
    BudgetRepository,
    PolicyEvaluatorService,
    RollingWindowBudgetService,
    AgentBudgetGuard,
    BudgetAlertRepository,
    BudgetAlertService,
    BudgetAlertWorker,
  ],
  exports: [BudgetService, PolicyEvaluatorService, RollingWindowBudgetService, AgentBudgetGuard],
})
export class BudgetModule {}
