import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Queues } from '../queues/queues.constants';
import { runWorkerJob } from './job-worker';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { ApprovalService } from '../modules/approvals/approval.service';

/**
 * Processor for the approval sweep queue.
 * Keeps business logic entirely inside ApprovalService.sweepExpired().
 */
@Processor(Queues.ApprovalSweep)
export class ApprovalSweepWorker extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(ApprovalSweepWorker.name);

  constructor(
    private readonly approvalService: ApprovalService,
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    await runWorkerJob({
      queue: Queues.ApprovalSweep,
      job,
      logger: this.logger,
      metrics: this.workerMetrics,
      defaultJobName: 'approval-sweep',
      handler: async () => {
        const result = await this.approvalService.sweepExpired();
        return result;
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.logger.log('ApprovalSweepWorker closed successfully');
    }
  }
}
