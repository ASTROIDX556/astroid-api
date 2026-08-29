import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Queues } from '../../../queues/queues.constants';
import { WebhookJobData, WebhookJobResult } from '../types/webhook-job.types';
import { hmacSign } from '../../../utils/crypto.util';

/**
 * BullMQ worker for processing webhook delivery jobs.
 * Implements exponential backoff retry logic and proper error handling.
 */
@Processor(Queues.Webhooks)
export class WebhookWorker extends WorkerHost {
  private readonly logger = new Logger(WebhookWorker.name);

  async process(job: Job<WebhookJobData>): Promise<WebhookJobResult> {
    const { webhookId, url, secret, eventName, payload, eventId } = job.data;

    this.logger.debug(`Processing webhook delivery job ${job.id} for ${eventName}`);

    try {
      const body = JSON.stringify(payload);
      const signature = hmacSign(secret, body);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-astroid-signature': signature,
          'x-astroid-event-id': eventId,
          'x-astroid-event': eventName,
          'user-agent': 'Astroid-Webhook-Bot/1.0',
        },
        body,
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.warn(
          `Webhook ${webhookId} responded ${response.status}: ${errorText}`,
        );
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      this.logger.debug(`Webhook ${webhookId} delivered successfully`);
      return { success: true, statusCode: response.status };
    } catch (error) {
      const errorMessage = (error as Error).message;
      this.logger.error(
        `Webhook ${webhookId} delivery failed (attempt ${job.attemptsMade + 1}): ${errorMessage}`,
      );

      if (job.attemptsMade >= 4) {
        this.logger.error(`Webhook ${webhookId} exhausted all retry attempts`);
      }

      return { success: false, error: errorMessage };
    }
  }
}
