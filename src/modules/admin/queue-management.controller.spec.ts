import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { QueueManagementController } from './queue-management.controller';
import { QueueManagementService } from './queue-management.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

describe('QueueManagementController', () => {
  let controller: QueueManagementController;
  let service: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    service = {
      listFailedJobs: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
      }),
      inspectJob: vi.fn().mockResolvedValue({
        id: 'job-1',
        name: 'test',
        queue: 'webhooks',
        data: {},
        opts: {},
        attemptsMade: 1,
        timestamp: 123456,
        status: 'failed',
      }),
      batchRetry: vi.fn().mockResolvedValue({
        retriedCount: 5,
        failedCount: 0,
        skippedCount: 0,
        queues: ['webhooks'],
        retriedJobIds: ['job-1', 'job-2'],
        errors: [],
      }),
      batchPurge: vi.fn().mockResolvedValue({
        purgedCount: 10,
        queues: ['webhooks'],
        removedJobIds: ['job-1', 'job-2'],
        errors: [],
      }),
      getQueueHealth: vi.fn().mockResolvedValue([
        {
          queue: 'webhooks',
          failed: 5,
          active: 2,
          waiting: 3,
          delayed: 0,
          completed: 100,
          paused: 0,
          totalProcessed: 107,
        },
      ]),
    };

    controller = new QueueManagementController(
      service as unknown as QueueManagementService,
    );
  });

  describe('RBAC Roles Guard Configuration', () => {
    it('has @Roles(UserRole.OWNER, UserRole.ADMIN) defined at the class level', () => {
      const reflector = new Reflector();
      const roles = reflector.get<UserRole[]>(ROLES_KEY, QueueManagementController);

      expect(roles).toBeDefined();
      expect(roles).toContain(UserRole.OWNER);
      expect(roles).toContain(UserRole.ADMIN);
      expect(roles).toHaveLength(2);
    });
  });

  describe('listFailedJobs', () => {
    it('delegates query to queueManagement service', async () => {
      const query = {
        queue: 'webhooks',
        page: 2,
        limit: 10,
        reasonContains: 'timeout',
      };

      await controller.listFailedJobs(query);

      expect(service.listFailedJobs).toHaveBeenCalledWith(query);
    });

    it('returns paginated results', async () => {
      const result = await controller.listFailedJobs({
        page: 1,
        limit: 20,
      });

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  describe('inspectJob', () => {
    it('delegates queue and id to queueManagement service', async () => {
      await controller.inspectJob('webhooks', 'job-42');

      expect(service.inspectJob).toHaveBeenCalledWith('webhooks', 'job-42');
    });

    it('returns job inspection details', async () => {
      const result = await controller.inspectJob('webhooks', 'job-1');

      expect(result.id).toBe('job-1');
      expect(result.status).toBe('failed');
    });
  });

  describe('batchRetry', () => {
    it('delegates batch retry with filter', async () => {
      const filter = {
        queue: 'webhooks',
        reasonContains: 'timeout',
        limit: 500,
      };

      await controller.batchRetry(filter);

      expect(service.batchRetry).toHaveBeenCalledWith(filter);
    });

    it('returns batch retry results', async () => {
      const result = await controller.batchRetry({ limit: 1000 });

      expect(result.retriedCount).toBe(5);
      expect(result.retriedJobIds).toEqual(['job-1', 'job-2']);
    });
  });

  describe('batchRetryInQueue', () => {
    it('merges queue path parameter into filter', async () => {
      const query = { limit: 100, reasonContains: '503' };

      await controller.batchRetryInQueue('notifications', query);

      expect(service.batchRetry).toHaveBeenCalledWith({
        ...query,
        queue: 'notifications',
      });
    });
  });

  describe('batchPurge', () => {
    it('delegates batch purge with filter', async () => {
      const filter = { queue: 'webhooks', limit: 500 };

      await controller.batchPurge(filter);

      expect(service.batchPurge).toHaveBeenCalledWith(filter);
    });

    it('returns batch purge results', async () => {
      const result = await controller.batchPurge({ limit: 1000 });

      expect(result.purgedCount).toBe(10);
      expect(result.queues).toContain('webhooks');
    });
  });

  describe('batchPurgeInQueue', () => {
    it('merges queue path parameter into filter', async () => {
      const query = { limit: 200 };

      await controller.batchPurgeInQueue('stellar-sync', query);

      expect(service.batchPurge).toHaveBeenCalledWith({
        ...query,
        queue: 'stellar-sync',
      });
    });
  });

  describe('getQueueHealth', () => {
    it('returns queue health snapshots', async () => {
      const result = await controller.getQueueHealth();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        queue: 'webhooks',
        failed: 5,
        totalProcessed: 107,
      });
    });

    it('delegates to queueManagement service', async () => {
      await controller.getQueueHealth();

      expect(service.getQueueHealth).toHaveBeenCalledOnce();
    });
  });
});
