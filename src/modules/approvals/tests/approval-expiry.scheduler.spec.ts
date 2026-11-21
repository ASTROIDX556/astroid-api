import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import {
  APPROVAL_EXPIRY_INTERVAL_MS,
  APPROVAL_EXPIRY_JOB_NAME,
  ApprovalExpiryScheduler,
} from '../approval-expiry.scheduler';
import { ApprovalExpiryWorker } from '../approval-expiry.worker';
import { ApprovalService } from '../approval.service';
import { Queues } from '../../../queues/queues.constants';

describe('ApprovalExpiryScheduler', () => {
  let queue: { add: ReturnType<typeof vi.fn> };
  let scheduler: ApprovalExpiryScheduler;

  beforeEach(() => {
    queue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
    scheduler = new ApprovalExpiryScheduler(queue as unknown as Queue);
  });

  it('registers a repeatable sweep job when the application starts', async () => {
    // Startup never awaits the Redis round trip: the add is issued and the
    // application keeps booting.
    scheduler.onModuleInit();
    await scheduler.register();

    expect(queue.add).toHaveBeenCalled();
    const [name, payload, options] = queue.add.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { repeat: { every: number }; attempts: number },
    ];
    expect(name).toBe(APPROVAL_EXPIRY_JOB_NAME);
    expect(payload).toEqual({});
    expect(options.repeat.every).toBe(APPROVAL_EXPIRY_INTERVAL_MS);
    expect(APPROVAL_EXPIRY_INTERVAL_MS).toBe(5 * 60 * 1000);
    // The shared retry policy applies to a failed sweep.
    expect(options.attempts).toBe(3);
  });

  it('never lets a queue outage prevent the application from booting', async () => {
    queue.add.mockRejectedValue(new Error('redis unavailable'));

    expect(() => scheduler.onModuleInit()).not.toThrow();
    await expect(scheduler.register()).resolves.toBeUndefined();
  });
});

describe('ApprovalExpiryWorker', () => {
  it('delegates each sweep to ApprovalService.expireStale', async () => {
    const expireStale = vi.fn().mockResolvedValue({ expired: 2, proposalIds: ['a', 'b'] });
    const worker = new ApprovalExpiryWorker({ expireStale } as unknown as ApprovalService);

    const result = await worker.process({
      name: APPROVAL_EXPIRY_JOB_NAME,
      id: 'job-1',
    } as never);

    expect(expireStale).toHaveBeenCalledTimes(1);
    expect(expireStale).toHaveBeenCalledWith(expect.any(Date));
    expect(result).toEqual({ expired: 2, proposalIds: ['a', 'b'] });
  });

  it('ignores jobs it does not own', async () => {
    const expireStale = vi.fn();
    const worker = new ApprovalExpiryWorker({ expireStale } as unknown as ApprovalService);

    const result = await worker.process({ name: 'something-else', id: 'job-2' } as never);

    expect(result).toBeNull();
    expect(expireStale).not.toHaveBeenCalled();
  });

  it('is bound to the approvals queue', () => {
    expect(Queues.Approvals).toBe('approvals');
  });
});
