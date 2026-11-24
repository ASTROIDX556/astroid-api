import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Queues } from '../../queues/queues.constants';
import { buildJobOptions } from '../../queues/queue-policy';

/** Stable id so every replica registers the same repeatable schedule once. */
export const IDEMPOTENCY_CLEANUP_SCHEDULER_ID = 'idempotency-cleanup';
export const IDEMPOTENCY_CLEANUP_JOB_NAME = 'idempotency-cleanup';

/** Expired records are harmless; an hourly sweep keeps the table bounded. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

/** Registers the repeatable expired-record cleanup job at boot. */
@Injectable()
export class IdempotencyCleanupScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdempotencyCleanupScheduler.name);

  constructor(@InjectQueue(Queues.IdempotencyCleanup) private readonly queue: Queue) {}

  onApplicationBootstrap(): void {
    void this.register().catch((error: unknown) => {
      this.logger.warn(
        `Could not register the idempotency cleanup schedule: ${(error as Error).message}`,
      );
    });
  }

  /** Upserts the scheduler so repeated boots never stack duplicate jobs. */
  async register(): Promise<void> {
    await this.queue.upsertJobScheduler(
      IDEMPOTENCY_CLEANUP_SCHEDULER_ID,
      { every: CLEANUP_INTERVAL_MS },
      {
        name: IDEMPOTENCY_CLEANUP_JOB_NAME,
        data: { trigger: 'scheduled' },
        opts: buildJobOptions(),
      },
    );
  }
}
