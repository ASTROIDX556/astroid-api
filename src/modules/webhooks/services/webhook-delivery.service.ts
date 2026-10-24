import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { Queues } from '../../../queues/queues.constants';
import { WEBHOOK_JOB_NAME, webhookJobOptionsFor } from '../../../queues/webhook.queue';
import { WebhookConfig } from '../../../config/webhook.config';
import { WebhookJobData } from '../types/webhook-job.types';
import { RequestContext } from '../../../common/context/request-context';
import { resolveRequestId } from '../../../common/helpers/request-id';

/**
 * Service for queuing webhook delivery jobs with BullMQ.
 *
 * Retry policy, jittered backoff and dead-letter settings come from
 * `@queues/webhook.queue` so the API-side enqueue options and the worker-side
 * queue registration can never drift apart.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    @InjectQueue(Queues.Webhooks)
    private readonly webhookQueue: Queue<WebhookJobData>,
    private readonly config: ConfigService,
  ) {}

  /** The resolved webhook delivery configuration. */
  private get settings(): WebhookConfig {
    return this.config.getOrThrow<WebhookConfig>('webhook');
  }

  /**
   * Queues a webhook delivery job.
   *
   * The job inherits the queue's retry policy: the configured number of
   * attempts, an exponential backoff with ±20% jitter and a maximum delay
   * applied by the queue's backoff strategy, and 24h retention of failed jobs
   * so exhausted deliveries remain inspectable.
   */
  async queueDelivery(data: WebhookJobData): Promise<void> {
    try {
      const metadata = {
        ...data.metadata,
        requestId: data.metadata?.requestId ?? RequestContext.getRequestId() ?? resolveRequestId(undefined),
        correlationId: data.metadata?.correlationId ?? RequestContext.getCorrelationId(),
        traceId: data.metadata?.traceId ?? RequestContext.getTraceId(),
      };
      metadata.correlationId ??= metadata.requestId;
      metadata.traceId ??= metadata.correlationId;
      const hasMetadata = Object.values(metadata).some((value) => value !== undefined);
      const jobData: WebhookJobData = {
        ...data,
        ...(hasMetadata ? { metadata } : {}),
      };
      await this.webhookQueue.add(
        WEBHOOK_JOB_NAME,
        jobData,
        webhookJobOptionsFor(this.settings),
      );
      this.logger.debug(`Queued webhook delivery for ${data.eventName} on webhook ${data.webhookId}`);
    } catch (error) {
      this.logger.error('Failed to queue webhook delivery');
      throw error;
    }
  }
}
