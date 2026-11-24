import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { DlqService } from './dlq.service';
import { Queues } from '../../queues/queues.constants';
import { DomainEventName } from '../../events/event-names';

function buildMockPrisma() {
  const domainEvent = {
    create: vi.fn().mockResolvedValue({ id: 'evt-1' }),
  };
  return { domainEvent };
}

describe('DlqService', () => {
  let service: DlqService;
  let mockQueue: Record<string, ReturnType<typeof vi.fn>>;
  let mockJob: Record<string, ReturnType<typeof vi.fn> | unknown>;
  let prismaMock: ReturnType<typeof buildMockPrisma>;

  beforeEach(() => {
    prismaMock = buildMockPrisma();
    mockJob = {
      id: 'job-100',
      name: 'send-notification',
      data: { userId: 'u-1', message: 'Hello' },
      opts: { attempts: 3 },
      failedReason: 'SMTP connection refused',
      stacktrace: ['Error: SMTP connection refused at SmtpClient.connect'],
      attemptsMade: 3,
      timestamp: 1725050000000,
      processedOn: 1725050001000,
      finishedOn: 1725050003000,
      returnvalue: null,
      getState: vi.fn().mockResolvedValue('failed'),
      retry: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    mockQueue = {
      getFailed: vi.fn().mockResolvedValue([mockJob]),
      getFailedCount: vi.fn().mockResolvedValue(1),
      getJob: vi.fn().mockResolvedValue(mockJob),
      clean: vi.fn().mockResolvedValue(['job-100']),
      getJobCounts: vi.fn().mockResolvedValue({
        failed: 1,
        active: 0,
        waiting: 2,
        delayed: 0,
        completed: 10,
        paused: 0,
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    service = new DlqService(prismaMock as unknown as never);
    // Override getOrCreateQueue to return our mock
    vi.spyOn(service, 'getOrCreateQueue').mockReturnValue(mockQueue as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listFailedJobs', () => {
    it('returns paginated failed jobs for a specific queue', async () => {
      const result = await service.listFailedJobs({
        queue: Queues.Notifications,
        page: 1,
        limit: 10,
      });

      expect(result.queue).toBe(Queues.Notifications);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          id: 'job-100',
          name: 'send-notification',
          queue: Queues.Notifications,
          failedReason: 'SMTP connection refused',
          attemptsMade: 3,
        }),
      );
    });

    it('aggregates failed jobs across all queues when no specific queue is provided', async () => {
      const result = await service.listFailedJobs({
        page: 1,
        limit: 20,
      });

      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].id).toBe('job-100');
    });
  });

  describe('getJobDetails', () => {
    it('returns complete inspection details for an existing job', async () => {
      const details = await service.getJobDetails(Queues.Notifications, 'job-100');

      expect(details.id).toBe('job-100');
      expect(details.queue).toBe(Queues.Notifications);
      expect(details.data).toEqual({ userId: 'u-1', message: 'Hello' });
      expect(details.failedReason).toBe('SMTP connection refused');
      expect(details.stacktrace).toEqual(['Error: SMTP connection refused at SmtpClient.connect']);
    });

    it('throws NotFoundException when the job does not exist in the queue', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      await expect(
        service.getJobDetails(Queues.Notifications, 'non-existent-job'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('retryJob', () => {
    it('retries a failed job and returns success confirmation', async () => {
      const result = await service.retryJob(Queues.Notifications, 'job-100');

      expect(result.retried).toBe(true);
      expect(result.jobId).toBe('job-100');
      expect(result.queue).toBe(Queues.Notifications);
      expect((mockJob.retry as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });

    it('emits an audit event for the requeue', async () => {
      await service.retryJob(Queues.Notifications, 'job-100');

      const createMock = prismaMock.domainEvent.create as Mock;
      expect(createMock).toHaveBeenCalledTimes(1);
      const { data } = createMock.mock.calls[0][0];
      expect(data.name).toBe(DomainEventName.JobRequeued);
      expect(data.aggregateType).toBe('ADMIN_DLQ');
      expect(data.payload).toEqual(
        expect.objectContaining({
          queue: Queues.Notifications,
          jobId: 'job-100',
          jobName: 'send-notification',
        }),
      );
    });

    it('continues retry even when audit event persistence fails', async () => {
      prismaMock.domainEvent.create.mockRejectedValue(new Error('db down'));

      const result = await service.retryJob(Queues.Notifications, 'job-100');

      expect(result.retried).toBe(true);
    });

    it('throws NotFoundException if job is not found', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      await expect(
        service.retryJob(Queues.Notifications, 'missing-job'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException if job is not in failed state', async () => {
      (mockJob.getState as ReturnType<typeof vi.fn>).mockResolvedValue('active');

      await expect(
        service.retryJob(Queues.Notifications, 'job-100'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('retryAllFailedJobs', () => {
    it('retries all failed jobs for a target queue', async () => {
      const result = await service.retryAllFailedJobs(Queues.Notifications);

      expect(result.retriedCount).toBe(1);
      expect(result.queues).toContain(Queues.Notifications);
      expect((mockJob.retry as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('emits a batch audit event when jobs are retried', async () => {
      await service.retryAllFailedJobs(Queues.Notifications);

      const createMock = prismaMock.domainEvent.create as Mock;
      expect(createMock).toHaveBeenCalledTimes(1);
      const { data } = createMock.mock.calls[0][0];
      expect(data.name).toBe(DomainEventName.JobRequeued);
      expect(data.payload).toEqual(
        expect.objectContaining({
          operation: 'batch_retry_all',
          retriedCount: 1,
        }),
      );
    });
  });

  describe('removeJob', () => {
    it('removes a job from the queue', async () => {
      const result = await service.removeJob(Queues.Notifications, 'job-100');

      expect(result.removed).toBe(true);
      expect(result.jobId).toBe('job-100');
      expect((mockJob.remove as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });

    it('throws NotFoundException if job to remove does not exist', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      await expect(
        service.removeJob(Queues.Notifications, 'non-existent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('purgeQueue', () => {
    it('purges failed jobs using queue.clean', async () => {
      const result = await service.purgeQueue({
        queue: Queues.Notifications,
        gracePeriodMs: 5000,
        limit: 500,
      });

      expect(mockQueue.clean).toHaveBeenCalledWith(5000, 500, 'failed');
      expect(result.purgedCount).toBe(1);
      expect(result.removedJobIds).toEqual(['job-100']);
    });
  });

  describe('getQueueStats', () => {
    it('returns job statistics across queues', async () => {
      const stats = await service.getQueueStats();

      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0]).toEqual(
        expect.objectContaining({
          failed: 1,
          waiting: 2,
          completed: 10,
        }),
      );
    });
  });
});
