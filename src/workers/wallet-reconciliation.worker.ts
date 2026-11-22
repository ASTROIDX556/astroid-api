import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Queues } from '../queues/queues.constants';
import { runWorkerJob } from './job-worker';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { WalletReconciliationService } from '../modules/wallets/services/wallet-reconciliation.service';

/**
 * Processor of the wallet reconciliation queue.
 *
 * The job is registered as a repeatable job by
 * {@link WalletReconciliationScheduler} and can also be enqueued on demand.
 * The handler never throws for an individual wallet failure — the service logs
 * it and keeps going — so a transient Horizon error for one account does not
 * fail (and thereby retry) the whole run.
 */
@Processor(Queues.WalletReconciliation)
export class WalletReconciliationWorker extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(WalletReconciliationWorker.name);

  constructor(
    private readonly reconciliation: WalletReconciliationService,
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    await runWorkerJob({
      queue: Queues.WalletReconciliation,
      job,
      logger: this.logger,
      metrics: this.workerMetrics,
      defaultJobName: 'wallet-reconciliation',
      handler: () => this.reconciliation.reconcile(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.logger.log('WalletReconciliationWorker closed successfully');
    }
  }
}
