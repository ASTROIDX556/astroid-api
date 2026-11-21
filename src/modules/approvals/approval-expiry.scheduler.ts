import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Queues } from '../../queues/queues.constants';
import { buildJobOptions } from '../../queues/queue-policy';

/** Job name of the approval expiry sweep. */
export const APPROVAL_EXPIRY_JOB_NAME = 'approval-expiry';

/**
 * Cadence of the sweep. Five minutes is frequent enough that a waiting agent
 * learns about an expired approval promptly, while keeping the janitor cheap.
 */
export const APPROVAL_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Registers the repeatable approval-expiry job.
 *
 * The job is a BullMQ *repeatable* job (`repeat.every`), so BullMQ owns the
 * scheduling and removes the previous repeatable registration when the
 * application restarts with a different cadence. Every replica may register
 * the same repeatable job: BullMQ deduplicates it by its repeat key, and the
 * sweeper itself is race safe, so a duplicated tick cannot expire a proposal
 * twice or emit a duplicate event.
 *
 * A Redis outage during registration is logged and swallowed — the scheduler
 * must never prevent the API from booting.
 */
@Injectable()
export class ApprovalExpiryScheduler implements OnModuleInit {
  private readonly logger = new Logger(ApprovalExpiryScheduler.name);

  constructor(@InjectQueue(Queues.Approvals) private readonly queue: Queue) {}

  /**
   * Fire-and-forget registration: `queue.add` opens a Redis connection, and
   * startup must not wait for (or fail on) it. `register()` logs any failure.
   */
  onModuleInit(): void {
    void this.register();
  }

  /** Adds (or refreshes) the repeatable sweep job. */
  async register(): Promise<void> {
    try {
      await this.queue.add(
        APPROVAL_EXPIRY_JOB_NAME,
        {},
        {
          ...buildJobOptions(),
          repeat: { every: APPROVAL_EXPIRY_INTERVAL_MS },
        },
      );
      this.logger.log(
        `Registered repeatable '${APPROVAL_EXPIRY_JOB_NAME}' job every ${
          APPROVAL_EXPIRY_INTERVAL_MS / 60_000
        } minute(s) on the '${Queues.Approvals}' queue`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to register the '${APPROVAL_EXPIRY_JOB_NAME}' repeatable job: ${(error as Error).message}`,
      );
    }
  }
}
