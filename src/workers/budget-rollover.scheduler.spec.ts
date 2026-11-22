import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  BUDGET_ROLLOVER_SCHEDULER_ID,
  BudgetRolloverScheduler,
} from './budget-rollover.scheduler';
import { BUDGET_ROLLOVER_JOB_NAME } from '../queues/budget-rollover.queue';
import { BudgetRolloverConfig } from '../config/budget-rollover.config';

const SETTINGS: BudgetRolloverConfig = {
  enabled: true,
  intervalMs: 60_000,
  batchSize: 100,
  maxBatches: 20,
};

describe('BudgetRolloverScheduler', () => {
  let queue: { upsertJobScheduler: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> };
  let settings: BudgetRolloverConfig;

  const build = () =>
    new BudgetRolloverScheduler(
      queue as unknown as Queue,
      { get: vi.fn(() => settings) } as unknown as ConfigService,
    );

  beforeEach(() => {
    queue = {
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
      add: vi.fn().mockResolvedValue({ id: 'manual-1' }),
    };
    settings = { ...SETTINGS };
  });

  it('registers one stable repeatable schedule', async () => {
    const scheduler = build();
    await scheduler.register();
    await scheduler.register();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      BUDGET_ROLLOVER_SCHEDULER_ID,
      { every: SETTINGS.intervalMs },
      expect.objectContaining({ name: BUDGET_ROLLOVER_JOB_NAME }),
    );
  });

  it('skips registration when disabled', async () => {
    settings = { ...SETTINGS, enabled: false };
    await expect(build().register()).resolves.toBe(false);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('enqueues a one-off run', async () => {
    await expect(build().trigger()).resolves.toBe('manual-1');
    expect(queue.add).toHaveBeenCalledWith(
      BUDGET_ROLLOVER_JOB_NAME,
      expect.objectContaining({ trigger: 'manual' }),
      expect.objectContaining({ jobId: expect.stringContaining('manual') }),
    );
  });
});
