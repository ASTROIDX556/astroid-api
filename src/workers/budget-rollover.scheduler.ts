import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { Queues } from '../queues/queues.constants';
import {
  BUDGET_ROLLOVER_JOB_NAME,
  budgetRolloverJobOptions,
} from '../queues/budget-rollover.queue';
import {
  DEFAULT_BUDGET_ROLLOVER_CONFIG,
  BudgetRolloverConfig,
} from '../config/budget-rollover.config';

/** Stable scheduler id: re-registering upserts the same schedule. */
export const BUDGET_ROLLOVER_SCHEDULER_ID = 'budget-rollover';

/**
 * Registers the repeatable budget rollover job at boot.
 *
 * `upsertJobScheduler` keyed by a stable id keeps the schedule idempotent even
 * when several API replicas boot at once. Redis failures are logged and ignored
 * so they cannot abort application startup.
 */
@Injectable()
export class BudgetRolloverScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BudgetRolloverScheduler.name);

  constructor(
    @InjectQueue(Queues.BudgetRollover) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    void this.register().catch((error: unknown) => {
      this.logger.warn(
        `Could not register the budget rollover schedule: ${(error as Error).message}`,
      );
    });
  }

  private settings(): BudgetRolloverConfig {
    return (
      this.config.get<BudgetRolloverConfig>('budgetRollover') ?? DEFAULT_BUDGET_ROLLOVER_CONFIG
    );
  }

  /** Registers (or updates) the repeatable job. Returns false when disabled. */
  async register(): Promise<boolean> {
    const settings = this.settings();
    if (!settings.enabled) {
      this.logger.log('Budget rollover is disabled (BUDGET_ROLLOVER_ENABLED=false)');
      return false;
    }

    await this.queue.upsertJobScheduler(
      BUDGET_ROLLOVER_SCHEDULER_ID,
      { every: settings.intervalMs },
      {
        name: BUDGET_ROLLOVER_JOB_NAME,
        data: { trigger: 'scheduled', requestedAt: new Date().toISOString() },
        opts: budgetRolloverJobOptions,
      },
    );
    this.logger.log(
      `Budget rollover scheduled every ${settings.intervalMs / 60_000} minute(s) ` +
        `with batch size ${settings.batchSize}`,
    );
    return true;
  }

  /** Enqueues a one-off rollover run on demand. */
  async trigger(): Promise<string | undefined> {
    const job = await this.queue.add(
      BUDGET_ROLLOVER_JOB_NAME,
      { trigger: 'manual', requestedAt: new Date().toISOString() },
      {
        ...budgetRolloverJobOptions,
        jobId: `${BUDGET_ROLLOVER_SCHEDULER_ID}-manual-${Date.now()}`,
      },
    );
    return job.id;
  }
}
