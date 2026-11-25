import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { DlqController } from './dlq.controller';
import { DlqService } from './dlq.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Queues } from '../../queues/queues.constants';

describe('DlqController', () => {
  let controller: DlqController;
  let service: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    service = {
      listFailedJobs: vi.fn().mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 20,
      }),
      getQueueStats: vi.fn().mockResolvedValue([
        {
          queue: Queues.DeadLetter,
          failed: 0,
          active: 0,
          waiting: 0,
          delayed: 0,
          completed: 0,
          paused: 0,
        },
      ]),
      getJobDetails: vi.fn().mockResolvedValue({
        id: 'job-1',
        queue: Queues.DeadLetter,
        name: 'test',
        data: {},
        opts: {},
        attemptsMade: 1,
        timestamp: 123456,
      }),
      retryJob: vi.fn().mockResolvedValue({
        jobId: 'job-1',
        queue: Queues.DeadLetter,
        retried: true,
        message: 'Job retried',
      }),
      retryAllFailedJobs: vi.fn().mockResolvedValue({
        retriedCount: 5,
        queues: [Queues.DeadLetter],
      }),
      removeJob: vi.fn().mockResolvedValue({
        jobId: 'job-1',
        queue: Queues.DeadLetter,
        removed: true,
      }),
      purgeQueue: vi.fn().mockResolvedValue({
        purgedCount: 10,
        removedJobIds: ['job-1', 'job-2'],
        queues: [Queues.DeadLetter],
      }),
    };

    controller = new DlqController(service as unknown as DlqService);
  });

  describe('RBAC Roles Guard Configuration', () => {
    it('has @Roles(UserRole.OWNER, UserRole.ADMIN) defined at the class level', () => {
      const reflector = new Reflector();
      const roles = reflector.get<UserRole[]>(ROLES_KEY, DlqController);

      expect(roles).toBeDefined();
      expect(roles).toContain(UserRole.OWNER);
      expect(roles).toContain(UserRole.ADMIN);
      expect(roles).toHaveLength(2);
    });
  });

  describe('Endpoints', () => {
    it('listFailedJobs delegates query to dlqService', async () => {
      const query = { page: 2, limit: 10, queue: Queues.Webhooks };
      const res = await controller.listFailedJobs(query);

      expect(service.listFailedJobs).toHaveBeenCalledWith(query);
      expect(res.page).toBe(1);
    });

    it('getQueueStats delegates to dlqService', async () => {
      const res = await controller.getQueueStats();

      expect(service.getQueueStats).toHaveBeenCalledOnce();
      expect(res).toHaveLength(1);
    });

    it('getJobDetails delegates queue and id to dlqService', async () => {
      await controller.getJobDetails(Queues.Webhooks, 'wh-job-1');

      expect(service.getJobDetails).toHaveBeenCalledWith(Queues.Webhooks, 'wh-job-1');
    });

    it('getDlqJobDetails defaults to DeadLetter queue', async () => {
      await controller.getDlqJobDetails('dlq-job-1');

      expect(service.getJobDetails).toHaveBeenCalledWith(Queues.DeadLetter, 'dlq-job-1');
    });

    it('retryJob delegates queue and id to dlqService', async () => {
      await controller.retryJob(Queues.Webhooks, 'wh-job-1');

      expect(service.retryJob).toHaveBeenCalledWith(Queues.Webhooks, 'wh-job-1');
    });

    it('retryDlqJob delegates to dlqService with default queue', async () => {
      await controller.retryDlqJob('dlq-job-1');

      expect(service.retryJob).toHaveBeenCalledWith(Queues.DeadLetter, 'dlq-job-1');
    });

    it('retryAllJobs delegates to dlqService with optional queue', async () => {
      await controller.retryAllJobs(Queues.Webhooks);

      expect(service.retryAllFailedJobs).toHaveBeenCalledWith(Queues.Webhooks);
    });

    it('retryQueueAllJobs delegates to dlqService', async () => {
      await controller.retryQueueAllJobs(Queues.Transactions);

      expect(service.retryAllFailedJobs).toHaveBeenCalledWith(Queues.Transactions);
    });

    it('removeJob delegates queue and id to dlqService', async () => {
      await controller.removeJob(Queues.Transactions, 'tx-job-1');

      expect(service.removeJob).toHaveBeenCalledWith(Queues.Transactions, 'tx-job-1');
    });

    it('removeDlqJob defaults to DeadLetter queue', async () => {
      await controller.removeDlqJob('dlq-job-1');

      expect(service.removeJob).toHaveBeenCalledWith(Queues.DeadLetter, 'dlq-job-1');
    });

    it('purgeQueue delegates query to dlqService', async () => {
      const purgeDto = { queue: Queues.Reports, gracePeriodMs: 1000, limit: 50 };
      await controller.purgeQueue(purgeDto);

      expect(service.purgeQueue).toHaveBeenCalledWith(purgeDto);
    });

    it('purgeSpecificQueue merges path parameter into purgeDto', async () => {
      const purgeDto = { gracePeriodMs: 0, limit: 100 };
      await controller.purgeSpecificQueue(Queues.RiskAnalysis, purgeDto);

      expect(service.purgeQueue).toHaveBeenCalledWith({
        ...purgeDto,
        queue: Queues.RiskAnalysis,
      });
    });
  });
});
