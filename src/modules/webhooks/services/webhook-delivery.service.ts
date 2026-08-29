import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Queues } from '../../../queues/queues.constants';
import { WebhookJobData } from '../types/webhook-job.types';

/**
 * Service for queuing webhook delivery jobs with BullMQ.
 * Handles retry logic and dead-letter queueing through the queue configuration.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    @InjectQueue(Queues.Webhooks)
    private readonly webhookQueue: Queue<WebhookJobData>,
  ) {}

  /**
   * Queues a webhook delivery job with exponential backoff retry policy.
   * The job will be processed by the webhook worker with automatic retries.
   * Uses 2000ms base delay for exponential backoff: 2000ms, 4000ms, 8000ms, 16000ms.
   * Maximum 5 attempts total.
   */
  async queueDelivery(data: WebhookJobData): Promise<void> {
    try {
      await this.webhookQueue.add('webhook-delivery', data, {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      });
      this.logger.debug(`Queued webhook delivery for ${data.eventName} to ${data.url}`);
    } catch (error) {
      this.logger.error(`Failed to queue webhook delivery: ${(error as Error).message}`);
      throw error;
    }
  }
}
