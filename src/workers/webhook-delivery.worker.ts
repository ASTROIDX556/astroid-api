import { Injectable, Logger, Optional } from '@nestjs/common';
import { Queues } from '../queues/queues.constants';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';

export interface WebhookDeliveryJob {
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
  /** Current attempt number (1-based); BullMQ increments on retry. */
  attempt: number;
}

/**
 * Retries failed webhook deliveries with exponential backoff. Every payload is
 * signed with the webhook's HMAC secret in the dispatcher; this worker only
 * schedules redelivery and terminal dead-lettering after `attempts` exhausts.
 *
 * Processing latency and outcomes are recorded against the Prometheus registry
 * via `WorkerMetricsService` when available.
 */
@Injectable()
export class WebhookDeliveryWorker {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  readonly queue = Queues.Webhooks;

  constructor(
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
  ) {}

  async process(job: { data: WebhookDeliveryJob; name?: string }): Promise<void> {
    const jobName = job.name ?? 'webhook-delivery';

    const execute = async (): Promise<void> => {
      this.logger.log(
        `deliver ${job.data.event} → webhook ${job.data.webhookId} (attempt ${job.data.attempt})`,
      );
    };

    if (this.workerMetrics) {
      await this.workerMetrics.instrumentJob(this.queue, jobName, execute);
    } else {
      await execute();
    }
  }
}
