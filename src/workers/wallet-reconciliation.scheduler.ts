import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { Queues } from '../queues/queues.constants';
import {
  DEFAULT_WALLET_RECONCILIATION_CONFIG,
  WalletReconciliationConfig,
} from '../config/wallet-reconciliation.config';

/** Stable scheduler id: re-registering upserts the same schedule. */
export const WALLET_RECONCILIATION_SCHEDULER_ID = 'wallet-reconciliation';

/**
 * Registers the repeatable reconciliation job at boot.
 *
 * `upsertJobScheduler` keyed by a stable scheduler id makes registration
 * idempotent: every replica booting (or a rollout creating several pods) ends up
 * with exactly one schedule instead of stacking duplicate repeatable jobs.
 * `trigger()` enqueues a one-off run on demand.
 */
@Injectable()
export class WalletReconciliationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(WalletReconciliationScheduler.name);

  constructor(
    @InjectQueue(Queues.WalletReconciliation) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    // Registration is best-effort and must never block or abort startup: Redis
    // may not be reachable yet when the API process boots. The scheduler is
    // re-registered on every boot with the same id, so a missed attempt is
    // corrected by the next replica/pod to start.
    void this.register().catch((error: unknown) => {
      this.logger.warn(
        `Could not register the wallet reconciliation schedule: ${(error as Error).message}`,
      );
    });
  }

  private settings(): WalletReconciliationConfig {
    return (
      this.config.get<WalletReconciliationConfig>('walletReconciliation') ??
      DEFAULT_WALLET_RECONCILIATION_CONFIG
    );
  }

  /** Registers (or updates) the repeatable job. Returns false when disabled. */
  async register(): Promise<boolean> {
    const settings = this.settings();
    if (!settings.enabled) {
      this.logger.log('Wallet reconciliation is disabled (WALLET_RECONCILIATION_ENABLED=false)');
      return false;
    }

    await this.queue.upsertJobScheduler(
      WALLET_RECONCILIATION_SCHEDULER_ID,
      { every: settings.intervalMs },
      {
        name: 'wallet-reconciliation',
        data: { trigger: 'scheduled' },
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      },
    );
    this.logger.log(
      `Wallet reconciliation scheduled every ${settings.intervalMs / 60_000} minute(s) ` +
        `with concurrency ${settings.concurrency}`,
    );
    return true;
  }

  /** Enqueues a one-off reconciliation run. */
  async trigger(): Promise<string | undefined> {
    const job = await this.queue.add(
      'wallet-reconciliation',
      { trigger: 'manual' },
      {
        jobId: `${WALLET_RECONCILIATION_SCHEDULER_ID}-manual-${Date.now()}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    );
    return job.id;
  }
}
