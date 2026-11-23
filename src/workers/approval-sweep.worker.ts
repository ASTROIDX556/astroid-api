import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Queues } from '../queues/queues.constants';
import { runWorkerJob } from './job-worker';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { ApprovalService } from '../modules/approvals/approval.service';
import { APPROVAL_EXPIRY_JOB_NAME, ApprovalExpiryJobData } from '../queues/approval-expiry.queue';

/**
 * Processor for the approval sweep queue. Handles two job kinds:
 *
 * - `approval-expire` – the delayed job scheduled when a proposal is created;
 *   expires that one proposal via ApprovalService.expireById().
 * - `approval-sweep`  – the periodic backstop sweep via sweepExpired().
 *
 * Business logic stays inside ApprovalService.
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
        if (job.name === APPROVAL_EXPIRY_JOB_NAME) {
          const { organizationId, proposalId } = job.data as ApprovalExpiryJobData;
          const expired = await this.approvalService.expireById(organizationId, proposalId);
          return { proposalId, expired };
        }
        return this.approvalService.sweepExpired();
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
