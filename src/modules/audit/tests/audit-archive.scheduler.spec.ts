import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AuditArchiveScheduler, AUDIT_ARCHIVE_JOB_NAME } from '../audit-archive.scheduler';

describe('AuditArchiveScheduler', () => {
  let queue: { add: ReturnType<typeof vi.fn> };
  let scheduler: AuditArchiveScheduler;

  function build(archiveEnabled = true): void {
    queue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) };
    const config = {
      get: vi.fn().mockReturnValue({
        archiveEnabled,
        archiveRetentionDays: 30,
        archiveBatchSize: 500,
        archiveMaxBatches: 20,
        retentionDays: 90,
      }),
    } as unknown as ConfigService;
    scheduler = new AuditArchiveScheduler(queue as unknown as Queue, config);
  }

  beforeEach(() => {
    build();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues the archival job on the audit archive queue', async () => {
    await scheduler.enqueueArchiveJob();

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, payload] = queue.add.mock.calls[0] as [string, { requestedAt: string }];
    expect(name).toBe(AUDIT_ARCHIVE_JOB_NAME);
    expect(payload.requestedAt).toBeDefined();
  });

  it('uses the shared retry and backoff policy of the queue', async () => {
    await scheduler.enqueueArchiveJob();

    const options = queue.add.mock.calls[0][2] as { attempts: number; backoff: { type: string } };
    expect(options.attempts).toBe(3);
    expect(options.backoff.type).toBe('exponential');
  });

  it('derives a stable job id from the hour so a tick is never queued twice', async () => {
    const at = new Date('2026-10-20T12:30:00.000Z');

    await scheduler.enqueueAt(at);
    await scheduler.enqueueAt(new Date('2026-10-20T12:45:00.000Z'));

    const first = queue.add.mock.calls[0][2] as { jobId: string };
    const second = queue.add.mock.calls[1][2] as { jobId: string };
    expect(first.jobId).toBe(second.jobId);
  });

  it('uses a different job id for a different hour', async () => {
    await scheduler.enqueueAt(new Date('2026-10-20T12:30:00.000Z'));
    await scheduler.enqueueAt(new Date('2026-10-20T13:30:00.000Z'));

    const first = queue.add.mock.calls[0][2] as { jobId: string };
    const second = queue.add.mock.calls[1][2] as { jobId: string };
    expect(first.jobId).not.toBe(second.jobId);
  });

  it('does not enqueue anything when the archival is disabled', async () => {
    build(false);

    await scheduler.enqueueArchiveJob();

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('never lets a queue outage escape into the scheduler', async () => {
    queue.add.mockRejectedValue(new Error('redis unavailable'));

    await expect(scheduler.enqueueArchiveJob()).resolves.toBeUndefined();
  });

  it('runs once per scheduled tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));

    await scheduler.enqueueArchiveJob();
    vi.advanceTimersByTime(60 * 60 * 1000);
    await scheduler.enqueueArchiveJob();

    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
