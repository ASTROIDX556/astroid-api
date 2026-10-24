import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { AuditArchiveWorker } from '../queues/audit-archive.worker';
import { AuditArchiveService } from '../audit-archive.service';
import { WorkerMetricsService } from '../../metrics/worker-metrics.service';
import { Queues } from '../../../queues/queues.constants';

describe('AuditArchiveWorker', () => {
  let worker: AuditArchiveWorker;
  let archive: { archive: ReturnType<typeof vi.fn> };
  let instrumentJob: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    archive = { archive: vi.fn().mockResolvedValue({ archivedRecords: 3, deletedRecords: 3 }) };
    instrumentJob = vi.fn(async (_queue: string, _job: string, fn: () => Promise<unknown>) => fn());
    worker = new AuditArchiveWorker(
      archive as unknown as AuditArchiveService,
      { instrumentJob } as unknown as WorkerMetricsService,
    );
  });

  it('runs the archival', async () => {
    await worker.process({ id: 'job-1', name: 'audit-archive', data: {} } as Job);

    expect(archive.archive).toHaveBeenCalledTimes(1);
  });

  it('instruments the job so its duration and outcome are measured', async () => {
    await worker.process({ id: 'job-1', name: 'audit-archive', data: {} } as Job);

    expect(instrumentJob).toHaveBeenCalledWith(
      Queues.AuditArchive,
      'audit-archive',
      expect.any(Function),
    );
  });

  it('rethrows a failed archival so the queue can retry it', async () => {
    archive.archive.mockRejectedValue(new Error('archive write failed'));

    await expect(
      worker.process({ id: 'job-1', name: 'audit-archive', data: {} } as Job),
    ).rejects.toThrow('archive write failed');
  });
});
