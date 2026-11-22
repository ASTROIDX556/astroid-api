import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  WALLET_RECONCILIATION_SCHEDULER_ID,
  WalletReconciliationScheduler,
} from './wallet-reconciliation.scheduler';
import { WalletReconciliationConfig } from '../config/wallet-reconciliation.config';

const SETTINGS: WalletReconciliationConfig = {
  enabled: true,
  intervalMs: 15 * 60 * 1000,
  concurrency: 5,
  driftThreshold: 0.0000001,
};

describe('WalletReconciliationScheduler', () => {
  let queue: {
    upsertJobScheduler: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
  };
  let settings: WalletReconciliationConfig;

  const build = () =>
    new WalletReconciliationScheduler(
      queue as unknown as Queue,
      { get: vi.fn(() => settings) } as unknown as ConfigService,
    );

  beforeEach(() => {
    queue = {
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
      add: vi.fn().mockResolvedValue({ id: 'manual-job-1' }),
    };
    settings = { ...SETTINGS };
  });

  it('registers a stable repeatable job so duplicate boots do not stack schedules', async () => {
    const scheduler = build();

    await scheduler.register();
    await scheduler.register();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(queue.upsertJobScheduler.mock.calls[0][0]).toBe(
      WALLET_RECONCILIATION_SCHEDULER_ID,
    );
    expect(queue.upsertJobScheduler.mock.calls[1][0]).toBe(
      WALLET_RECONCILIATION_SCHEDULER_ID,
    );
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      WALLET_RECONCILIATION_SCHEDULER_ID,
      { every: SETTINGS.intervalMs },
      expect.objectContaining({ name: 'wallet-reconciliation' }),
    );
  });

  it('does not schedule when reconciliation is disabled', async () => {
    settings = { ...SETTINGS, enabled: false };
    const scheduler = build();

    await expect(scheduler.register()).resolves.toBe(false);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('enqueues a one-off run on demand', async () => {
    const scheduler = build();

    await expect(scheduler.trigger()).resolves.toBe('manual-job-1');
    expect(queue.add).toHaveBeenCalledWith(
      'wallet-reconciliation',
      { trigger: 'manual' },
      expect.objectContaining({ jobId: expect.stringContaining('manual') }),
    );
  });
});
