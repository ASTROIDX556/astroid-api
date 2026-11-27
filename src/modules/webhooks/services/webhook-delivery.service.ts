import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue, JobsOptions } from 'bullmq';

import { QueueJobMetadata, Queues } from '../../../queues/queues.constants';
import {
  buildWebhookJobId,
  WEBHOOK_JOB_NAME,
  webhookJobOptions,
  webhookJobOptionsFor,
} from '../../../queues/webhook.queue';
import { DEFAULT_WEBHOOK_CONFIG, WebhookConfig } from '../../../config/webhook.config';
import { WebhookJobData } from '../types/webhook-job.types';
import { RequestContext } from '../../../common/context/request-context';
import { resolveRequestId } from '../../../common/helpers/request-id';
import { buildWebhookConcurrencyGroup } from '../types/webhook-job.types';

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
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** The resolved webhook delivery configuration. */
  private get settings(): WebhookConfig {
    if (this.config && typeof this.config.get === 'function') {
      return this.config.get<WebhookConfig>('webhook') ?? DEFAULT_WEBHOOK_CONFIG;
    }
    if (this.config && typeof this.config.getOrThrow === 'function') {
      return this.config.getOrThrow<WebhookConfig>('webhook');
    }
    return DEFAULT_WEBHOOK_CONFIG;
  }

  /**
   * Queues a webhook delivery job.
   *
   * The job inherits the queue's retry policy: the configured number of
   * attempts, an exponential backoff with ±20% jitter and a maximum delay
   * applied by the queue's backoff strategy, and 24h retention of failed jobs
   * so exhausted deliveries remain inspectable.
   *
   * The job id is derived deterministically from the event and the
   * subscription, so a duplicate dispatch of the same event — two workers, a
   * retried API call, a replay — is ignored by BullMQ instead of producing a
   * second concurrent delivery. Because completed and failed jobs are
   * retained (see the retention options), the guard also covers a duplicate
   * that arrives just after the first delivery finished, for as long as the
   * job record lives.
   */
  async queueDelivery(data: WebhookJobData): Promise<void> {
    try {
      // Who caused the delivery: ids only, never credentials.
      const actorId = data.metadata?.actorId ?? RequestContext.getActorId();
      const apiKeyId = data.metadata?.apiKeyId ?? RequestContext.getApiKeyId();
      const metadata: QueueJobMetadata = {
        ...data.metadata,
        requestId: data.metadata?.requestId ?? RequestContext.getRequestId() ?? resolveRequestId(undefined),
        correlationId: data.metadata?.correlationId ?? RequestContext.getCorrelationId(),
        traceId: data.metadata?.traceId ?? RequestContext.getTraceId(),
        ...(actorId ? { actorId } : {}),
        ...(apiKeyId ? { apiKeyId } : {}),
      };
      metadata.correlationId ??= metadata.requestId;
      metadata.traceId ??= metadata.correlationId;
      const hasMetadata = Object.values(metadata).some((value) => value !== undefined);
      const jobData: WebhookJobData = {
        ...data,
        ...(hasMetadata ? { metadata } : {}),
      };
      const baseOptions = this.config ? webhookJobOptionsFor(this.settings) : webhookJobOptions;
      const options: JobsOptions & { group?: string } = {
        ...baseOptions,
        jobId: buildWebhookJobId(data.eventId, data.webhookId),
        group: buildWebhookConcurrencyGroup(data.webhookId),
      };
      await this.webhookQueue.add(
        WEBHOOK_JOB_NAME,
        jobData,
        options,
      );
      this.logger.debug(`Queued webhook delivery for ${data.eventName} on webhook ${data.webhookId}`);
    } catch (error) {
      this.logger.error('Failed to queue webhook delivery');
      throw error;
    }
  }
}
