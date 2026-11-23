import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalRepository } from './approval.repository';
import { ApprovalIdempotencyRepository } from './approval-idempotency.repository';
import { ApprovalExpiryScheduler } from './approval-expiry.scheduler';
import { ApprovalExpiryWorker } from './approval-expiry.worker';
import { TransactionModule } from '../transactions/transaction.module';
import { BudgetModule } from '../budgets/budget.module';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';
import { redisConfig } from '../../config/redis.config';

/**
 * Approvals module. Imports the transactions and budget modules so proposals
 * can execute or cancel transactions and release held budgets upon expiration.
 *
 * Also owns the scheduled approval expiry sweep: the scheduler registers a
 * repeatable job on the `approval-sweep` queue and the worker delegates each
 * tick to {@link ApprovalService.expireStale}.
 */
@Module({
  imports: [
    TransactionModule,
    BudgetModule,
    BullModule.registerQueue({
      ...createQueueRegistrationOptions(Queues.ApprovalSweep, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      }),
      connection: {
        host: redisConfig().host,
        port: redisConfig().port,
        password: redisConfig().password,
        db: redisConfig().db,
      },
    }),
  ],
  controllers: [ApprovalController],
  providers: [
    ApprovalService,
    ApprovalRepository,
    ApprovalIdempotencyRepository,
    ApprovalExpiryScheduler,
    ApprovalExpiryWorker,
  ],
  exports: [ApprovalService],
})
export class ApprovalModule {}
