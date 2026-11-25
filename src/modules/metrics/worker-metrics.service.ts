import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * Wraps BullMQ job processing with automatic Prometheus metric collection.
 *
 * Inject this service in any worker and call `instrumentJob` to track
 * processing latency (`worker_job_duration_seconds` histogram) and
 * outcome (`worker_jobs_total` counter) per queue and job name.
 *
 * @example
 * ```ts
 * constructor(private readonly workerMetrics: WorkerMetricsService) {}
 *
 * async process(job: Job): Promise<Result> {
 *   return this.workerMetrics.instrumentJob('webhooks', job.name, async () => {
 *     // ... actual job processing ...
 *     return result;
 *   });
 * }
 * ```
 */
@Injectable()
export class WorkerMetricsService {
  private readonly logger = new Logger(WorkerMetricsService.name);

  constructor(private readonly metricsService: MetricsService) {}

  /**
   * Instruments a job processing function with latency and outcome tracking.
   * On success, records the duration with result="success".
   * On failure, records the duration with result="failure" and re-throws.
   *
   * @param queue    Queue name (e.g. "webhooks", "transactions")
   * @param jobName  Job name or identifier for labeling
   * @param fn       The actual job processing function to instrument
   * @returns The result of the processing function
   */
  async instrumentJob<T>(
    queue: string,
    jobName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      const result = await fn();
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metricsService.recordJobCompletion(queue, jobName, durationSeconds, 'success');
      return result;
    } catch (error) {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metricsService.recordJobCompletion(queue, jobName, durationSeconds, 'failure');
      this.logger.debug(
        `Job "${jobName}" on queue "${queue}" failed after ${durationSeconds.toFixed(3)}s: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
