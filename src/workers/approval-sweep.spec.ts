import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { ApprovalSweepWorker } from './approval-sweep.worker';
import {
  APPROVAL_SWEEP_SCHEDULER_ID,
  ApprovalSweepScheduler,
} from './approval-sweep.scheduler';
import { ApprovalService } from '../modules/approvals/approval.service';
import { ApprovalConfig } from '../config/approval.config';

describe('ApprovalSweepWorker & Scheduler', () => {
  let approvalService: {
    sweepExpired: ReturnType<typeof vi.fn>;
  };
  let queue: {
    upsertJobScheduler: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
  };
  let config: {
    get: ReturnType<typeof vi.fn>;
  };

  const settings: ApprovalConfig = {
    ttlHours: 72,
    sweepIntervalMs: 60_000,
    sweepBatchSize: 100,
  };

  beforeEach(() => {
    approvalService = {
      sweepExpired: vi.fn().mockResolvedValue({ scanned: 5, expired: 2 }),
    };
    queue = {
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
      add: vi.fn().mockResolvedValue({ id: 'manual-sweep-job-1' }),
    };
    config = {
      get: vi.fn().mockReturnValue(settings),
    };
  });

  describe('ApprovalSweepWorker', () => {
    it('processes an approval sweep job by delegating to approvalService.sweepExpired()', async () => {
      const worker = new ApprovalSweepWorker(
        approvalService as unknown as ApprovalService,
      );

      const job = {
        name: 'approval-sweep',
        data: { trigger: 'scheduled' },
      } as Job;

      await worker.process(job);

      expect(approvalService.sweepExpired).toHaveBeenCalledTimes(1);
    });
  });

  describe('ApprovalSweepScheduler', () => {
    it('registers a stable repeatable job with configured interval', async () => {
      const scheduler = new ApprovalSweepScheduler(
        queue as unknown as Queue,
        config as unknown as ConfigService,
      );

      await scheduler.register();

      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        APPROVAL_SWEEP_SCHEDULER_ID,
        { every: 60_000 },
        expect.objectContaining({ name: 'approval-sweep' }),
      );
    });

    it('triggers a one-off run on demand', async () => {
      const scheduler = new ApprovalSweepScheduler(
        queue as unknown as Queue,
        config as unknown as ConfigService,
      );

      const jobId = await scheduler.trigger();

      expect(jobId).toBe('manual-sweep-job-1');
      expect(queue.add).toHaveBeenCalledWith(
        'approval-sweep',
        { trigger: 'manual' },
        expect.objectContaining({ jobId: expect.stringContaining('manual') }),
      );
    });
  });
});
