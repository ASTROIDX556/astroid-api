import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalRepository } from './approval.repository';
import { TransactionModule } from '../transactions/transaction.module';
import { BudgetModule } from '../budgets/budget.module';

/**
 * Approvals module. Imports the transactions and budget modules so proposals
 * can execute or cancel transactions and release held budgets upon expiration.
 */
@Module({
  imports: [TransactionModule, BudgetModule],
  controllers: [ApprovalController],
  providers: [ApprovalService, ApprovalRepository],
  exports: [ApprovalService],
})
export class ApprovalModule {}
