import { Module } from '@nestjs/common';
import { BudgetController } from './budget.controller';
import { BudgetService } from './budget.service';
import { BudgetRepository } from './budget.repository';
import { BudgetResetService } from './services/budget-reset.service';
import { BudgetResetWorker } from './workers/budget-reset.worker';

/**
 * Budget module. Exports the service so the transactions pipeline can enforce
 * spend limits (assertWithinBudget) and record realised spend (consume).
 * Also provides the periodic budget-reset cron worker.
 */
@Module({
  controllers: [BudgetController],
  providers: [BudgetService, BudgetRepository, BudgetResetService, BudgetResetWorker],
  exports: [BudgetService, BudgetResetService],
})
export class BudgetModule {}
