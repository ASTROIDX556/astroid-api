import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ApprovalRepository } from './approval.repository';
import { ApprovalIdempotencyRepository } from './approval-idempotency.repository';
import { TransactionModule } from '../transactions/transaction.module';
import { BudgetModule } from '../budgets/budget.module';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';
import { redisConfig } from '../../config/redis.config';

/**
 * Approvals module. Imports the transactions and budget modules so proposals
 * can execute or cancel transactions and release held budgets upon expiration.
 *
 * The scheduled approval expiry sweep is registered in the WorkersModule
 * via ApprovalSweepScheduler (uses upsertJobScheduler for idempotent
 * registration) and ApprovalSweepWorker (delegates to ApprovalService.sweepExpired).
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
  ],
  exports: [ApprovalService],
})
export class ApprovalModule {}
