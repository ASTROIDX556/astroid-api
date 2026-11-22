import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Queues } from '../queues/queues.constants';
import { BUDGET_ROLLOVER_JOB_NAME, BudgetRolloverJobData } from '../queues/budget-rollover.queue';
import { runWorkerJob } from './job-worker';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { BudgetRolloverService } from '../modules/budgets/services/budget-rollover.service';

/**
 * Processor of the budget rollover queue. Each budget is committed in its own
 * database transaction, so a failure only leaves the later budgets for the next
 * tick instead of rolling back work that already succeeded.
 */
@Processor(Queues.BudgetRollover)
export class BudgetRolloverWorker extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(BudgetRolloverWorker.name);

  constructor(
    private readonly rollover: BudgetRolloverService,
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
  ) {
    super();
  }

  async process(job: Job<BudgetRolloverJobData>): Promise<void> {
    await runWorkerJob({
      queue: Queues.BudgetRollover,
      job,
      logger: this.logger,
      metrics: this.workerMetrics,
      defaultJobName: BUDGET_ROLLOVER_JOB_NAME,
      handler: () => this.rollover.rolloverExpired(undefined, job.data?.batchSize),
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.logger.log('BudgetRolloverWorker closed successfully');
    }
  }
}
