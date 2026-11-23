import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Queues } from '../../../queues/queues.constants';
import { WebhookJobData } from '../types/webhook-job.types';
import { WebhookRetryPolicy } from '../webhook-retry.policy';
import {
  WEBHOOK_BACKOFF_TYPE,
  loadWebhookRetrySettings,
} from '../../../config/webhook.config';

/**
 * Queues webhook delivery jobs. The job carries the queue's retry policy
 * (maximum attempts + the named custom backoff schedule the worker registers),
 * while the delivery record in Postgres remains the authoritative attempt log.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private readonly policy: WebhookRetryPolicy;

  constructor(
    @InjectQueue(Queues.Webhooks)
    private readonly webhookQueue: Queue<WebhookJobData>,
    @Optional() policy?: WebhookRetryPolicy,
  ) {
    this.policy = policy ?? new WebhookRetryPolicy(loadWebhookRetrySettings());
  }

  /**
   * Queues a webhook delivery. Retries use the capped, jittered backoff
   * schedule registered by the worker (default 30s → 30m, max 6 attempts).
   */
  async queueDelivery(data: WebhookJobData): Promise<void> {
    try {
      await this.webhookQueue.add('webhook-delivery', data, {
        attempts: this.policy.maxAttempts,
        backoff: { type: WEBHOOK_BACKOFF_TYPE },
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
