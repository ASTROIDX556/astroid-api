import { Injectable, Logger, Optional } from '@nestjs/common';
import { Queues } from '../queues/queues.constants';
import { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { signWebhookPayload } from '../modules/webhooks/utils/signing';

export interface WebhookDeliveryJob {
  webhookId: string;
  url?: string;
  secret?: string;
  event: string;
  payload: Record<string, unknown>;
  attempt: number;
}

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
        `deliver ${job.data.event} -> webhook ${job.data.webhookId} (attempt ${job.data.attempt})`,
      );
      
      const { url, secret, payload } = job.data;
      if (!url || !secret) {
        this.logger.warn(`Webhook ${job.data.webhookId} missing url or secret`);
        return;
      }
      
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify(payload);
      const signature = signWebhookPayload(secret, timestamp, body);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Astroid-Signature': signature,
          'X-Astroid-Timestamp': timestamp,
        },
        body,
      });
      
      if (!response.ok) {
        throw new Error(`Failed to deliver webhook: ${response.statusText}`);
      }
    };

    if (this.workerMetrics) {
      await this.workerMetrics.instrumentJob(this.queue, jobName, execute);
    } else {
      await execute();
    }
  }
}
