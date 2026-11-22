import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalRepository } from './approval.repository';
import { ApprovalIdempotencyRepository } from './approval-idempotency.repository';
import { TransactionModule } from '../transactions/transaction.module';

/**
 * Approvals module. Imports the transactions module so an approved proposal can
 * execute its underlying transaction and a rejected one can cancel it.
 */
@Module({
  imports: [TransactionModule],
  controllers: [ApprovalController],
  providers: [ApprovalService, ApprovalRepository, ApprovalIdempotencyRepository],
  exports: [ApprovalService],
})
export class ApprovalModule {}
