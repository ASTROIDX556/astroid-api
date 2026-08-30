import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { Queues } from '../../queues/queues.constants';
import { DomainEventName } from '../../events/event-names';

const getJob = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const queueClose = vi.fn();
const eventsClose = vi.fn();
const eventsOn = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    getJob,
    add,
    close: (...args: unknown[]) => {
      queueClose(...args);
      return Promise.resolve();
    },
  })),
  QueueEvents: vi.fn().mockImplementation((name: string) => ({
    name,
    on: eventsOn,
    close: (...args: unknown[]) => {
      eventsClose(...args);
      return Promise.resolve();
    },
  })),
}));

vi.mock('../../config/redis.config', () => ({
  redisConfig: () => ({ host: 'localhost', port: 6379, password: '', db: 0 }),
}));

import { DeadLetterService } from './dead-letter.service';

function buildMockPrisma() {
  const domainEvent = {
    create: vi.fn().mockResolvedValue({ id: 'evt-1' }),
    findMany: vi.fn().mockResolvedValue([]),
  };
  return {
    domainEvent,
    prisma: { domainEvent },
  };
}

function buildExhaustedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-123',
    name: 'webhook-delivery',
    data: { webhookId: 'wh-1', organizationId: 'org-1', url: 'https://example.com/hook' },
    attemptsMade: 5,
    stacktrace: ['Error: HTTP 500 (attempt 5)', '    at deliver (webhook.worker.ts:88)'],
    opts: { attempts: 5, backoff: { type: 'exponential' } },
    remove,
    ...overrides,
  };
}

describe('DeadLetterService', () => {
  let service: DeadLetterService;
  let prismaMock: ReturnType<typeof buildMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock = buildMockPrisma();
    service = new DeadLetterService(prismaMock.prisma as never);
  });

  describe('onModuleInit', () => {
    it('registers a failed listener on every named queue', () => {
      service.onModuleInit();

      expect(eventsOn).toHaveBeenCalledTimes(Object.keys(Queues).length);
      expect(eventsOn).toHaveBeenCalledWith('failed', expect.any(Function));
    });
  });

  describe('handleFailed', () => {
    it('logs and persists full context for an exhausted job without crashing', async () => {
      getJob.mockResolvedValue(buildExhaustedJob());

      await service.handleFailed(Queues.Webhooks, 'job-123', 'HTTP 500');

      const createMock = prismaMock.domainEvent.create as Mock;
      expect(createMock).toHaveBeenCalledTimes(1);
      const { data } = createMock.mock.calls[0][0];
      expect(data.name).toBe(DomainEventName.JobFailed);
      expect(data.aggregateType).toBe('dead_letter');
      expect(data.aggregateId).toBe('job-123');
      expect(data.organizationId).toBe('org-1');
      expect(data.payload).toEqual(
        expect.objectContaining({
          queue: 'webhooks',
          jobId: 'job-123',
          name: 'webhook-delivery',
          attemptsMade: 5,
          failedReason: 'HTTP 500',
          stacktrace: expect.arrayContaining([
            'Error: HTTP 500 (attempt 5)',
            '    at deliver (webhook.worker.ts:88)',
          ]),
          data: expect.objectContaining({ webhookId: 'wh-1' }),
        }),
      );
    });

    it('does not persist mid-retry failures that still have attempts remaining', async () => {
      getJob.mockResolvedValue(
        buildExhaustedJob({ attemptsMade: 2, opts: { attempts: 5, backoff: { type: 'exponential' } } }),
      );

      await service.handleFailed(Queues.Webhooks, 'job-123', 'HTTP 503');

      expect(prismaMock.domainEvent.create).not.toHaveBeenCalled();
    });

    it('captures unrecoverable failures on the first attempt', async () => {
      getJob.mockResolvedValue(
        buildExhaustedJob({
          attemptsMade: 1,
          opts: { attempts: 5, backoff: { type: 'exponential' } },
          stacktrace: ['UnrecoverableError: HTTP 422 validation failed'],
        }),
      );

      await service.handleFailed(Queues.Webhooks, 'job-422', 'HTTP 422 validation failed');

      expect(prismaMock.domainEvent.create).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the persistence layer fails', async () => {
      getJob.mockResolvedValue(buildExhaustedJob());
      prismaMock.domainEvent.create.mockRejectedValue(
        new Error('db connection refused'),
      );

      await expect(
        service.handleFailed(Queues.Webhooks, 'job-123', 'HTTP 500'),
      ).resolves.toBeUndefined();
    });

    it('records a minimal entry when the job record is no longer available', async () => {
      getJob.mockResolvedValue(null);

      await service.handleFailed(Queues.Notifications, 'missed-job', 'timeout');

      const createMock = prismaMock.domainEvent.create as Mock;
      expect(createMock).toHaveBeenCalledTimes(1);
      const { data } = createMock.mock.calls[0][0];
      expect(data.aggregateId).toBe('missed-job');
      expect(data.payload).toEqual(
        expect.objectContaining({ queue: 'notifications', jobId: 'missed-job', attemptsMade: 0 }),
      );
    });

    it('never throws when the queue lookup itself fails', async () => {
      getJob.mockRejectedValue(new Error('redis unavailable'));

      await expect(
        service.handleFailed('webhooks', 'job-123', 'boom'),
      ).resolves.toBeUndefined();
    });
  });

  describe('requeue', () => {
    it('re-drives a failed job with a fresh job id', async () => {
      getJob.mockResolvedValue(buildExhaustedJob());

      const result = await service.requeue(Queues.Webhooks, 'job-123');

      const addMock = add as Mock;
      expect(addMock).toHaveBeenCalledTimes(1);
      const [name, data, opts] = addMock.mock.calls[0];
      expect(name).toBe('webhook-delivery');
      expect(data).toEqual(
        expect.objectContaining({ webhookId: 'wh-1', organizationId: 'org-1' }),
      );
      expect(opts.jobId).toMatch(/^dlq-retry-job-123-\d+$/);
      expect(result.requeuedJobId).toMatch(/^dlq-retry-job-123-\d+$/);
    });

    it('throws a clear error for an unknown queue', async () => {
      await expect(service.requeue('nope', 'job-123')).rejects.toThrow(
        'Unknown BullMQ queue',
      );
    });

    it('throws when the source job cannot be found', async () => {
      getJob.mockResolvedValue(null);

      await expect(service.requeue(Queues.Webhooks, 'missing')).rejects.toThrow(
        'job not found',
      );
    });
  });

  describe('purge', () => {
    it('removes a failed job from Redis and records a purge ledger entry', async () => {
      remove.mockResolvedValue(undefined);
      getJob.mockResolvedValue(buildExhaustedJob());

      const result = await service.purge(Queues.Webhooks, 'job-123');

      expect(remove).toHaveBeenCalledTimes(1);
      const createMock = prismaMock.domainEvent.create as Mock;
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: DomainEventName.JobPurged,
            aggregateId: 'job-123',
            payload: expect.objectContaining({ queue: 'webhooks', jobId: 'job-123' }),
          }),
        }),
      );
      expect(result).toEqual({ queue: 'webhooks', jobId: 'job-123', purged: true });
    });

    it('throws when the job to purge cannot be found', async () => {
      getJob.mockResolvedValue(null);

      await expect(service.purge(Queues.Webhooks, 'missing')).rejects.toThrow('job not found');
    });
  });

  describe('listForOrganization', () => {
    it('queries the ledger scoped to DLQ events and an organization', async () => {
      prismaMock.domainEvent.findMany.mockResolvedValue([{ id: 'evt-1' }]);

      const result = await service.listForOrganization('org-1', Queues.Webhooks);

      expect(prismaMock.domainEvent.findMany).toHaveBeenCalled();
      const where = (prismaMock.domainEvent.findMany as Mock).mock.calls[0][0].where;
      expect(where.organizationId).toBe('org-1');
      expect(where.name.in).toEqual([
        DomainEventName.JobFailed,
        DomainEventName.JobRequeued,
        DomainEventName.JobPurged,
      ]);
      expect(where.payload).toEqual({ path: ['queue'], equals: 'webhooks' });
      expect(result).toHaveLength(1);
    });
  });

  describe('onModuleDestroy', () => {
    it('closes every queue events and queue handle', async () => {
      service.onModuleInit();
      await service.onModuleDestroy();

      expect(eventsClose).toHaveBeenCalledTimes(Object.keys(Queues).length);
      expect(queueClose).toHaveBeenCalledTimes(Object.keys(Queues).length);
    });
  });
});