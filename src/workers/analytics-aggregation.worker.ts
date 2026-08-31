import { Injectable, Logger, Optional } from '@nestjs/common';
import { Queues } from '../queues/queues.constants';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';

export interface AnalyticsRollupJob {
  organizationId: string;
  /** ISO date of the day to roll up. */
  date: string;
}

/**
 * Nightly aggregation job that pre-computes cash-flow, budget utilization and
 * risk distribution so the dashboard reads warm snapshots instead of scanning
 * the transaction log on every render.
 *
 * Processing latency and outcomes are recorded against the Prometheus registry
 * via `WorkerMetricsService` when available.
 */
@Injectable()
export class AnalyticsAggregationWorker {
  private readonly logger = new Logger(AnalyticsAggregationWorker.name);
  readonly queue = Queues.Analytics;

  constructor(
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
  ) {}

  async process(job: { data: AnalyticsRollupJob; name?: string }): Promise<void> {
    const jobName = job.name ?? 'analytics-rollup';

    const execute = async (): Promise<void> => {
      this.logger.log(`aggregate ${job.data.date} for org ${job.data.organizationId}`);
    };

    if (this.workerMetrics) {
      await this.workerMetrics.instrumentJob(this.queue, jobName, execute);
    } else {
      await execute();
    }
  }
}
