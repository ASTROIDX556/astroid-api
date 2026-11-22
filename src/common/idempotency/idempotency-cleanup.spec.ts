import { describe, expect, it, vi } from 'vitest';
import {
  IDEMPOTENCY_CLEANUP_JOB_NAME,
  IDEMPOTENCY_CLEANUP_SCHEDULER_ID,
  IdempotencyCleanupScheduler,
} from './idempotency-cleanup.scheduler';
import { IdempotencyCleanupWorker } from './idempotency-cleanup.worker';
import { Queues } from '../../queues/queues.constants';

describe('idempotency record cleanup', () => {
  it('registers one repeatable BullMQ scheduler', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
    const scheduler = new IdempotencyCleanupScheduler(queue as never);

    await expect(scheduler.register()).resolves.toBeUndefined();

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      IDEMPOTENCY_CLEANUP_SCHEDULER_ID,
      expect.objectContaining({ every: 60 * 60 * 1_000 }),
      expect.objectContaining({ name: IDEMPOTENCY_CLEANUP_JOB_NAME }),
    );
  });

  it('prunes expired records when the job runs', async () => {
    const idempotency = { deleteExpired: vi.fn().mockResolvedValue({ count: 7 }) };
    const worker = new IdempotencyCleanupWorker(idempotency as never);

    const result = await worker.process({
      id: 'job-1',
      name: IDEMPOTENCY_CLEANUP_JOB_NAME,
      data: {},
    } as never);

    expect(idempotency.deleteExpired).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ count: 7 });
    expect(Queues.IdempotencyCleanup).toBe('idempotency-cleanup');
  });
});
