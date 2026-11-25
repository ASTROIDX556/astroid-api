import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Queues } from '../../../queues/queues.constants';
import { runWorkerJob } from '../../../workers/job-worker';
import { AuditArchiveService } from '../audit-archive.service';
import { WorkerMetricsService } from '../../metrics/worker-metrics.service';

/**
 * Consumes the audit archival queue.
 *
 * The worker owns the failure handling: a failed archival is rethrown so
 * BullMQ applies the shared retry and backoff policy, and the terminal failure
 * is routed to the dead-letter queue by the queue failure listener. The
 * archival itself is idempotent, so a retry can never duplicate an archive or
 * lose a record.
 */
@Processor(Queues.AuditArchive)
export class AuditArchiveWorker extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(AuditArchiveWorker.name);

  constructor(
    private readonly archiveService: AuditArchiveService,
    private readonly workerMetrics: WorkerMetricsService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    await runWorkerJob({
      queue: Queues.AuditArchive,
      job,
      logger: this.logger,
      defaultJobName: 'audit-archive',
      metrics: this.workerMetrics,
      handler: () => this.archiveService.archive(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.logger.log('AuditArchiveWorker closed successfully');
    }
  }
}
