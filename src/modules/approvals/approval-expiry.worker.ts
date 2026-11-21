import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Queues } from '../../queues/queues.constants';
import { ApprovalService, ApprovalExpiryResult } from './approval.service';
import { APPROVAL_EXPIRY_JOB_NAME } from './approval-expiry.scheduler';

/**
 * Consumes the `approvals` queue.
 *
 * The worker only invokes {@link ApprovalService.expireStale} — the sweep logic
 * (conditional transition, events, logging) lives in the service. Unknown job
 * names are ignored so the same queue can host future approval jobs.
 */
@Processor(Queues.Approvals)
export class ApprovalExpiryWorker extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(ApprovalExpiryWorker.name);

  constructor(private readonly approvals: ApprovalService) {
    super();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }

  async process(job: Job): Promise<ApprovalExpiryResult | null> {
    if (job.name !== APPROVAL_EXPIRY_JOB_NAME) {
      this.logger.warn(`Ignoring unknown job '${job.name}' on the approvals queue`);
      return null;
    }

    this.logger.debug(`Running approval expiry sweep ${job.id}`);
    const result = await this.approvals.expireStale(new Date());
    this.logger.debug(
      `Approval expiry sweep ${job.id} finished: ${result.expired} proposal(s) expired`,
    );
    return result;
  }
}
