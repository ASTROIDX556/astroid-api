import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { QueueManagementService } from './queue-management.service';

vi.mock('../../config/redis.config', () => ({
  redisConfig: () => ({ host: 'localhost', port: 6379, password: '', db: 0 }),
}));

// We mock Queue at module level to prevent real Redis connections
vi.mock('bullmq', () => ({
  Queue: vi.fn(),
}));

function buildFailedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-100',
    name: 'webhook-delivery',
    data: { webhookId: 'wh-1', url: 'https://example.com/hook' },
    opts: { attempts: 5, backoff: { type: 'exponential' } },
    failedReason: 'HTTP 503 Service Unavailable',
    stacktrace: ['Error: HTTP 503 at deliver\n    at process (worker.ts:88)'],
    attemptsMade: 5,
    timestamp: 1725050000000,
    processedOn: 1725050001000,
    finishedOn: 1725050003000,
    returnvalue: null,
    retry: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue('failed'),
    ...overrides,
  };
}

function buildMockQueue() {
  return {
    getFailed: vi.fn().mockResolvedValue([buildFailedJob()]),
    getFailedCount: vi.fn().mockResolvedValue(1),
    getJob: vi.fn().mockResolvedValue(buildFailedJob()),
    clean: vi.fn().mockResolvedValue(['job-100']),
    getJobCounts: vi.fn().mockResolvedValue({
      failed: 1,
      active: 2,
      waiting: 5,
      delayed: 0,
      completed: 100,
      paused: 0,
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('QueueManagementService', () => {
  let service: QueueManagementService;
  let mockQueue: ReturnType<typeof buildMockQueue>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new QueueManagementService();
    mockQueue = buildMockQueue();
    vi.spyOn(service as never, 'getOrCreateQueue').mockReturnValue(mockQueue as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listFailedJobs', () => {
    it('returns paginated failed jobs for a specific queue', async () => {
      const result = await service.listFailedJobs({ queue: 'webhooks', page: 1, limit: 20 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('job-100');
      expect(result.items[0].queue).toBeDefined();
    });

    it('filters by failed reason substring', async () => {
      mockQueue.getFailed.mockResolvedValue([
        buildFailedJob({ id: 'job-1', failedReason: 'HTTP 503 Service Unavailable' }),
        buildFailedJob({ id: 'job-2', failedReason: 'Connection refused' }),
      ]);

      const result = await service.listFailedJobs({
        queue: 'webhooks',
        reasonContains: '503',
        page: 1,
        limit: 100,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('job-1');
    });

    it('filters by job name', async () => {
      mockQueue.getFailed.mockResolvedValue([
        buildFailedJob({ id: 'job-1', name: 'webhook-delivery' }),
        buildFailedJob({ id: 'job-2', name: 'balance-sync' }),
      ]);

      const result = await service.listFailedJobs({
        queue: 'webhooks',
        jobName: 'balance-sync',
        page: 1,
        limit: 100,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('balance-sync');
    });

    it('filters by time range', async () => {
      mockQueue.getFailed.mockResolvedValue([
        buildFailedJob({ id: 'job-1', finishedOn: 1725050003000 }),
        buildFailedJob({ id: 'job-2', finishedOn: 1725060003000 }),
      ]);

      const result = await service.listFailedJobs({
        queue: 'webhooks',
        timeRange: { from: 1725050002000 },
        page: 1,
        limit: 100,
      });

      expect(result.items).toHaveLength(2);
    });

    it('returns empty list when no jobs match filter', async () => {
      mockQueue.getFailed.mockResolvedValue([
        buildFailedJob({ failedReason: 'SMTP timeout' }),
      ]);

      const result = await service.listFailedJobs({
        queue: 'webhooks',
        reasonContains: 'nonexistent',
        page: 1,
        limit: 20,
      });

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('inspectJob', () => {
    it('returns detailed job inspection with derived status', async () => {
      const inspection = await service.inspectJob('notifications', 'job-100');

      expect(inspection.id).toBe('job-100');
      expect(inspection.queue).toBe('notifications');
      expect(inspection.status).toBe('exhausted');
      expect(inspection.processingDurationMs).toBe(2000);
      expect(inspection.data).toEqual({ webhookId: 'wh-1', url: 'https://example.com/hook' });
      expect(inspection.stacktrace).toEqual(
        expect.arrayContaining([expect.stringContaining('HTTP 503')]),
      );
    });

    it('marks unrecoverable jobs with status "unrecoverable"', async () => {
      mockQueue.getJob.mockResolvedValue(
        buildFailedJob({
          attemptsMade: 1,
          stacktrace: ['UnrecoverableError: HTTP 422 validation failed'],
        }),
      );

      const inspection = await service.inspectJob('webhooks', 'job-100');

      expect(inspection.status).toBe('unrecoverable');
    });

    it('marks early failures with status "failed"', async () => {
      mockQueue.getJob.mockResolvedValue(
        buildFailedJob({
          attemptsMade: 1,
          stacktrace: ['Error: temporary timeout'],
        }),
      );

      const inspection = await service.inspectJob('webhooks', 'job-100');

      expect(inspection.status).toBe('failed');
    });

    it('throws NotFoundException for non-existent job', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      await expect(
        service.inspectJob('webhooks', 'non-existent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('batchRetry', () => {
    it('retries all failed jobs in a queue', async () => {
      mockQueue.getFailed.mockResolvedValue([
        buildFailedJob({ id: 'job-1' }),
        buildFailedJob({ id: 'job-2' }),
      ]);

      const result = await service.batchRetry({ queue: 'webhooks', limit: 1000 });

      expect(result.retriedCount).toBe(2);
      expect(result.retriedJobIds).toEqual(['job-1', 'job-2']);
      expect(result.queues).toContain('webhooks');
      expect(result.failedCount).toBe(0);
    });

    it('skips jobs that do not match filter criteria', async () => {
      mockQueue.getFailed.mockResolvedValue([
        buildFailedJob({ id: 'job-1', failedReason: 'HTTP 503' }),
        buildFailedJob({ id: 'job-2', failedReason: 'SMTP timeout' }),
      ]);

      const result = await service.batchRetry({
        queue: 'notifications',
        reasonContains: '503',
        limit: 1000,
      });

      expect(result.retriedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.retriedJobIds).toEqual(['job-1']);
    });

    it('handles retry failures gracefully', async () => {
      const failingJob = buildFailedJob({ id: 'job-err' });
      (failingJob.retry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Redis connection lost'));
      mockQueue.getFailed.mockResolvedValue([failingJob]);

      const result = await service.batchRetry({ queue: 'webhooks', limit: 1000 });

      expect(result.retriedCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('Redis connection lost');
    });

    it('retries across all queues when no specific queue is given', async () => {
      const result = await service.batchRetry({ limit: 1000 });

      expect(result.queues.length).toBeGreaterThan(0);
      expect(typeof result.retriedCount).toBe('number');
    });
  });

  describe('batchPurge', () => {
    it('purges all failed jobs using queue.clean', async () => {
      const result = await service.batchPurge({ queue: 'webhooks', limit: 1000 });

      expect(mockQueue.clean).toHaveBeenCalledWith(0, 1000, 'failed');
      expect(result.purgedCount).toBe(1);
      expect(result.removedJobIds).toEqual(['job-100']);
      expect(result.queues).toContain('webhooks');
    });

    it('handles purge errors gracefully', async () => {
      mockQueue.clean.mockRejectedValue(new Error('Redis unavailable'));

      const result = await service.batchPurge({ queue: 'webhooks', limit: 1000 });

      expect(result.purgedCount).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('Redis unavailable');
    });

    it('purges across all queues when no specific queue is given', async () => {
      const result = await service.batchPurge({ limit: 1000 });

      expect(result.queues.length).toBeGreaterThan(0);
    });
  });

  describe('getQueueHealth', () => {
    it('returns health snapshot for all queues', async () => {
      const snapshots = await service.getQueueHealth();

      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0]).toMatchObject({
        queue: expect.any(String),
        failed: expect.any(Number),
        active: expect.any(Number),
        waiting: expect.any(Number),
        delayed: expect.any(Number),
        completed: expect.any(Number),
        paused: expect.any(Number),
        totalProcessed: expect.any(Number),
      });
    });

    it('calculates totalProcessed correctly', async () => {
      const snapshots = await service.getQueueHealth();
      const snapshot = snapshots.find((s) => s.queue === 'webhooks') ?? snapshots[0];

      expect(snapshot.totalProcessed).toBe(103);
    });

    it('handles errors for individual queues gracefully', async () => {
      mockQueue.getJobCounts.mockRejectedValueOnce(new Error('Redis timeout'));

      const snapshots = await service.getQueueHealth();

      expect(snapshots.length).toBeGreaterThan(0);
    });
  });

  describe('derived job status', () => {
    it('returns "failed" for jobs with few attempts', async () => {
      mockQueue.getJob.mockResolvedValue(
        buildFailedJob({ attemptsMade: 1, stacktrace: [] }),
      );

      const inspection = await service.inspectJob('webhooks', 'job-1');
      expect(inspection.status).toBe('failed');
    });

    it('returns "exhausted" for jobs with 3+ attempts', async () => {
      mockQueue.getJob.mockResolvedValue(
        buildFailedJob({ attemptsMade: 3, stacktrace: [] }),
      );

      const inspection = await service.inspectJob('webhooks', 'job-1');
      expect(inspection.status).toBe('exhausted');
    });

    it('returns "unrecoverable" for UnrecoverableError in stacktrace', async () => {
      mockQueue.getJob.mockResolvedValue(
        buildFailedJob({
          attemptsMade: 1,
          stacktrace: ['UnrecoverableError: invalid state'],
        }),
      );

      const inspection = await service.inspectJob('webhooks', 'job-1');
      expect(inspection.status).toBe('unrecoverable');
    });

    it('computes processingDurationMs when timestamps are available', async () => {
      mockQueue.getJob.mockResolvedValue(
        buildFailedJob({ processedOn: 1000, finishedOn: 4500 }),
      );

      const inspection = await service.inspectJob('webhooks', 'job-1');
      expect(inspection.processingDurationMs).toBe(3500);
    });

    it('sets processingDurationMs to undefined when timestamps are missing', async () => {
      mockQueue.getJob.mockResolvedValue(
        buildFailedJob({ processedOn: undefined, finishedOn: undefined }),
      );

      const inspection = await service.inspectJob('webhooks', 'job-1');
      expect(inspection.processingDurationMs).toBeUndefined();
    });
  });
});
