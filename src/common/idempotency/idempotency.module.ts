import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyCleanupScheduler } from './idempotency-cleanup.scheduler';
import { IdempotencyCleanupWorker } from './idempotency-cleanup.worker';

/** Prisma-backed idempotency support and its repeatable cleanup job. */
@Module({
  imports: [
    BullModule.registerQueue(createQueueRegistrationOptions(Queues.IdempotencyCleanup)),
  ],
  providers: [IdempotencyService, IdempotencyCleanupScheduler, IdempotencyCleanupWorker],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
