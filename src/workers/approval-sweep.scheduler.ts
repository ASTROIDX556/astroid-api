import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { Queues } from '../queues/queues.constants';
import { ApprovalConfig } from '../config/approval.config';

export const APPROVAL_SWEEP_SCHEDULER_ID = 'approval-sweep';

/**
 * Registers the repeatable approval sweep job at boot.
 *
 * Uses `upsertJobScheduler` keyed by a stable scheduler id for idempotent registration
 * across multi-replica deployments.
 */
@Injectable()
export class ApprovalSweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ApprovalSweepScheduler.name);

  constructor(
    @Optional() @InjectQueue(Queues.ApprovalSweep) private readonly queue?: Queue,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.queue) return;
    void this.register().catch((error: unknown) => {
      this.logger.warn(
        `Could not register approval sweep schedule: ${(error as Error).message}`,
      );
    });
  }

  private settings(): { sweepIntervalMs: number } {
    const approval = this.config?.get<ApprovalConfig>('approval');
    return {
      sweepIntervalMs: approval?.sweepIntervalMs ?? 60_000,
    };
  }

  async register(): Promise<boolean> {
    if (!this.queue) return false;
    const settings = this.settings();
    await this.queue.upsertJobScheduler(
      APPROVAL_SWEEP_SCHEDULER_ID,
      { every: settings.sweepIntervalMs },
      {
        name: 'approval-sweep',
        data: { trigger: 'scheduled' },
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      },
    );
    this.logger.log(`Approval sweep scheduled every ${settings.sweepIntervalMs}ms`);
    return true;
  }

  async trigger(): Promise<string | undefined> {
    if (!this.queue) return undefined;
    const job = await this.queue.add(
      'approval-sweep',
      { trigger: 'manual' },
      {
        jobId: `${APPROVAL_SWEEP_SCHEDULER_ID}-manual-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    );
    return job.id;
  }
}
