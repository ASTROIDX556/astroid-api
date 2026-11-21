import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalRepository } from './approval.repository';
import { ApprovalExpiryScheduler } from './approval-expiry.scheduler';
import { ApprovalExpiryWorker } from './approval-expiry.worker';
import { TransactionModule } from '../transactions/transaction.module';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';

/**
 * Approvals module. Imports the transactions module so an approved proposal can
 * execute its underlying transaction and a rejected one can cancel it.
 *
 * Also owns the scheduled approval expiry sweep: the scheduler registers a
 * repeatable job on the `approvals` queue every five minutes and the worker
 * delegates each tick to {@link ApprovalService.expireStale}.
 */
@Module({
  imports: [
    TransactionModule,
    BullModule.registerQueue(createQueueRegistrationOptions(Queues.Approvals)),
  ],
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
