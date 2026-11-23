import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue, Job } from 'bullmq';
import { QueueObservabilityService } from './queue-observability.service';
import { QueueObservabilityConfig } from '../../config/queue-observability.config';
import { ConfigService } from '@nestjs/config';
import { Queues } from '../../queues/queues.constants';

const mockJob = (overrides: Partial<Job> = {}): Job => ({
  id: '1',
  name: 'test-job',
  data: { foo: 'bar' },
  opts: { attempts: 5 },
  attemptsMade: 2,
  failedReason: 'Test error',
  stacktrace: ['Error: Test error'],
  timestamp: Date.now() - 1000,
  processedOn: Date.now() - 500,
  finishedOn: Date.now(),
  returnvalue: { success: true },
  ...overrides,
}) as unknown as Job;

const mockQueue = (jobs: Job[] = [], counts: Record<string, number> = {}): Partial<Queue> => ({
  getJobCounts: vi.fn().mockResolvedValue({
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  }),
  getJobs: vi.fn().mockResolvedValue(jobs.filter((j) => j.opts?.attempts === undefined || j.opts.attempts > 0)),
  getFailed: vi.fn().mockResolvedValue(jobs),
  close: vi.fn().mockResolvedValue(undefined),
  name: 'test-queue',
});

describe('QueueObservabilityService', () => {
  let service: QueueObservabilityService;
  let mockConfig: Partial<QueueObservabilityConfig>;
  let mockConfigService: Partial<ConfigService>;

  beforeEach(async () => {
    mockConfig = {
      enabled: true,
      maxFailedJobsPerQueue: 10,
    };

    mockConfigService = {
      get: vi.fn().mockReturnValue(mockConfig),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueObservabilityService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<QueueObservabilityService>(QueueObservabilityService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getObservability', () => {
    it('should return observability data for all registered queues', async () => {
      const queueNames = Object.values(Queues);
      const mockQueues = queueNames.map((name) =>
        mockQueue(
          [mockJob({ id: `${name}-failed-1`, name: 'test-job', failedReason: 'HTTP 500' })],
          { waiting: 5, active: 2, delayed: 1, completed: 100, failed: 3 },
        ),
      );

      (service as { getQueueHandle: (name: string) => Partial<Queue> }).getQueueHandle = (name: string) =>
        mockQueues.find((q) => q.name === name) || mockQueue();

      const result = await service.getObservability();

      expect(result.queues).toHaveLength(queueNames.length);
      expect(result.timestamp).toBeDefined();
      expect(result.queues[0]).toMatchObject({
        queue: expect.any(String),
        counts: {
          waiting: expect.any(Number),
          active: expect.any(Number),
          delayed: expect.any(Number),
          completed: expect.any(Number),
          failed: expect.any(Number),
        },
        oldestWaitingJobAgeMs: expect.any(Number),
        failedJobs: expect.any(Array),
      });
    });

    it('should strip payload from failed jobs', async () => {
      const failedJob = mockJob({
        id: '1',
        name: 'webhook-delivery',
        data: { secret: 'sensitive-data', webhookId: 'wh-123' },
        failedReason: 'HTTP 500',
        attemptsMade: 3,
        processedOn: Date.now() - 1000,
      });

      const mockQ = mockQueue([failedJob], { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 1 });

      vi
        .spyOn(service as { getQueueHandle: (name: string) => Partial<Queue> }, 'getQueueHandle')
        .mockReturnValue(mockQ);

      const result = await service.getObservability();

      const webhookQueue = result.queues.find((q) => q.queue === 'webhooks');
      expect(webhookQueue).toBeDefined();
      if (webhookQueue) {
        expect(webhookQueue.failedJobs[0]).toMatchObject({
          id: '1',
          name: 'webhook-delivery',
          failedReason: 'HTTP 500',
          attemptsMade: 3,
          processedOn: expect.any(Number),
        });
        expect(webhookQueue.failedJobs[0]).not.toHaveProperty('data');
      }
    });

    it('should respect maxFailedJobsPerQueue cap (max 20)', async () => {
      mockConfig.maxFailedJobsPerQueue = 25; // Should be capped at 20
      const manyFailedJobs = Array.from({ length: 25 }, (_, i) =>
        mockJob({ id: String(i), name: `job-${i}`, failedReason: 'Error' }),
      );

      const mockQ = mockQueue(manyFailedJobs, { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 25 });

      vi
        .spyOn(service as { getQueueHandle: (name: string) => Partial<Queue> }, 'getQueueHandle')
        .mockReturnValue(mockQ);

      const result = await service.getObservability();

      const webhookQueue = result.queues.find((q) => q.queue === 'webhooks');
      expect(webhookQueue).toBeDefined();
      if (webhookQueue) {
        expect(webhookQueue.failedJobs.length).toBeLessThanOrEqual(20);
      }
    });

    it('should calculate oldestWaitingJobAgeMs correctly', async () => {
      const oldTimestamp = Date.now() - 5000;
      const waitingJob = mockJob({
        id: 'waiting-1',
        name: 'waiting-job',
        timestamp: oldTimestamp,
      });

      const mockQ = mockQueue(
        [mockJob({ id: '1', failedReason: 'Error' })],
        { waiting: 1, active: 0, delayed: 0, completed: 0, failed: 1 },
      );
      (mockQ.getJobs as ReturnType<typeof vi.fn>).mockResolvedValue([waitingJob]);

      vi
        .spyOn(service as { getQueueHandle: (name: string) => Partial<Queue> }, 'getQueueHandle')
        .mockReturnValue(mockQ);

      const result = await service.getObservability();

      const webhookQueue = result.queues.find((q) => q.queue === 'webhooks');
      expect(webhookQueue).toBeDefined();
      if (webhookQueue) {
        expect(webhookQueue.oldestWaitingJobAgeMs).toBeGreaterThanOrEqual(4500);
        expect(webhookQueue.oldestWaitingJobAgeMs).toBeLessThanOrEqual(5500);
      }
    });

    it('should return null for oldestWaitingJobAgeMs when no waiting jobs', async () => {
      const mockQ = mockQueue([], { waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 });
      (mockQ.getJobs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      vi
        .spyOn(service as { getQueueHandle: (name: string) => Partial<Queue> }, 'getQueueHandle')
        .mockReturnValue(mockQ);

      const result = await service.getObservability();

      const webhookQueue = result.queues.find((q) => q.queue === 'webhooks');
      expect(webhookQueue).toBeDefined();
      if (webhookQueue) {
        expect(webhookQueue.oldestWaitingJobAgeMs).toBeNull();
      }
    });

    it('should throw when Redis/queue query fails', async () => {
      const mockQ = mockQueue();
      (mockQ.getJobCounts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Redis connection failed'));

      vi
        .spyOn(service as { getQueueHandle: (name: string) => Partial<Queue> }, 'getQueueHandle')
        .mockReturnValue(mockQ);

      await expect(service.getObservability()).rejects.toThrow('Redis connection failed');
    });

    it('should return empty failedJobs array when no failed jobs', async () => {
      const mockQ = mockQueue([], { waiting: 0, active: 0, delayed: 0, completed: 10, failed: 0 });

      vi
        .spyOn(service as { getQueueHandle: (name: string) => Partial<Queue> }, 'getQueueHandle')
        .mockReturnValue(mockQ);

      const result = await service.getObservability();

      const webhookQueue = result.queues.find((q) => q.queue === 'webhooks');
      expect(webhookQueue).toBeDefined();
      if (webhookQueue) {
        expect(webhookQueue.failedJobs).toEqual([]);
      }
    });
  });

  describe('onModuleDestroy', () => {
    it('should close all queue handles', async () => {
      const mockQ1 = mockQueue();
      const mockQ2 = mockQueue();
      (service as { queueHandles: Map<string, Queue> }).queueHandles.set('queue1', mockQ1 as Queue);
      (service as { queueHandles: Map<string, Queue> }).queueHandles.set('queue2', mockQ2 as Queue);

      await service.onModuleDestroy();

      expect(mockQ1.close).toHaveBeenCalled();
      expect(mockQ2.close).toHaveBeenCalled();
    });
  });
});