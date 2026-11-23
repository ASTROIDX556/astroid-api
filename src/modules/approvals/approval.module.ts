import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalRepository } from './approval.repository';
import { ApprovalExpiryScheduler } from './approval-expiry.scheduler';
import { ApprovalExpiryWorker } from './approval-expiry.worker';
import { TransactionModule } from '../transactions/transaction.module';
import { BudgetModule } from '../budgets/budget.module';

/**
 * Approvals module. Imports the transactions and budget modules so proposals
 * can execute or cancel transactions and release held budgets upon expiration.
 */
@Module({
  imports: [TransactionModule, BudgetModule],
  controllers: [ApprovalController],
  providers: [
    ApprovalService,
    ApprovalRepository,
    ApprovalExpiryScheduler,
    ApprovalExpiryWorker,
  ],
  exports: [ApprovalService],
})
export class ApprovalModule {}
