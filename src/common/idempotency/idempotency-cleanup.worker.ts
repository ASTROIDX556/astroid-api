import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Queues } from '../../queues/queues.constants';
import { runWorkerJob } from '../../workers/job-worker';
import { IdempotencyService } from './idempotency.service';
import { IDEMPOTENCY_CLEANUP_JOB_NAME } from './idempotency-cleanup.scheduler';

/** Consumes the repeatable cleanup queue and prunes expired key records. */
@Processor(Queues.IdempotencyCleanup)
export class IdempotencyCleanupWorker extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyCleanupWorker.name);

  constructor(private readonly idempotency: IdempotencyService) {
    super();
  }

  async process(job: Job): Promise<{ count: number }> {
    return runWorkerJob({
      queue: Queues.IdempotencyCleanup,
      job,
      logger: this.logger,
      defaultJobName: IDEMPOTENCY_CLEANUP_JOB_NAME,
      handler: () => this.idempotency.deleteExpired(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}
