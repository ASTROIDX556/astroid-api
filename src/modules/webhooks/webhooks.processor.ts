import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Queues } from '../../queues/queues.constants';
import { WebhookJobData, WebhookJobResult } from './types/webhook-job.types';
import { signWebhookPayload, WEBHOOK_SIGNATURE_VERSION } from './utils/signing';
import { PrismaService } from '../../database/prisma.service';
import { WorkerMetricsService } from '../../modules/metrics/worker-metrics.service';
import { WebhookAuditService } from './services/webhook-audit.service';
import { queueConfig, QueueConfig } from '../../config/queue.config';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../../common/constants/headers';

/**
 * BullMQ job processor for webhook event delivery with exponential backoff + jitter.
 * Implements the configured retry strategy:
 * - A bounded maximum number of attempts
 * - Exponential backoff with randomized jitter
 *   (prevents thundering herd against subscriber endpoints)
 * - Permanent 3xx/4xx errors stop immediately; 408, 429, 5xx and network errors retry
 * - Persistent delivery status tracking (PENDING → RETRYING → FAILED/DELIVERED)
 * - Fail-safe: retry failures never crash the master process
 *
 * Jitter is applied via a custom backoffStrategy configured on the BullMQ
 * queue registration (see webhook.module.ts). BullMQ reads the strategy from
 * queue.opts.settings.backoffStrategy at retry time.
 *
 * Processing latency and outcomes are recorded against the Prometheus registry
 * via `WorkerMetricsService` when available.
 */
import { OnModuleDestroy } from '@nestjs/common';

@Processor(Queues.Webhooks)
export class WebhooksProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(WebhooksProcessor.name);
  private readonly config: QueueConfig;

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.worker) {
      this.worker.on('failed', (job, err) => {
        this.logger.error(`Job ${job?.id} failed: ${err.message}`);
      });
      this.worker.on('error', (err) => {
        this.logger.error(`Worker error: ${err.message}`);
      });
      this.worker.on('stalled', (jobId) => {
        this.logger.warn(`Job ${jobId} stalled`);
      });
    }
  }
  constructor(
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
    @Optional() private readonly webhookAudit?: WebhookAuditService,
    @Optional() configService?: ConfigService,
  ) {
    super();
    this.config = configService?.get<QueueConfig>('queue') ?? queueConfig();
  }

  /**
   * Audit entry for a delivery that will not be retried again: an unrecoverable
   * 4xx or the final attempt. `WebhookAuditService` swallows its own failures, so
   * this can never mask the original delivery error.
   */
  private async auditTerminalFailure(
    job: Job<WebhookJobData>,
    failedReason: string,
    responseStatus?: number,
    endpoint = job.data.url,
  ): Promise<void> {
    if (!this.webhookAudit) return;
    try {
      await this.webhookAudit.recordTerminalFailure({
        webhookId: job.data.webhookId,
        organizationId: job.data.organizationId,
        url: endpoint,
        eventName: job.data.eventName,
        eventId: job.data.eventId,
        attemptsMade: job.attemptsMade + 1,
        failedReason,
        responseStatus,
      });
    } catch (error) {
      // Never let compliance bookkeeping mask the original delivery failure.
      this.logger.warn(
        `Could not audit webhook ${job.data.webhookId} failure: ${(error as Error).message}`,
      );
    }
  }

  private async resolveSubscription(
    webhookId: string,
    organizationId: string,
  ): Promise<{ secret: string; url: string }> {
    const client = this.prisma?.workerClient ?? this.prisma;
    if (!client) throw new UnrecoverableError('Webhook subscription is unavailable');
    const webhook = await client.webhook.findFirst({
      where: { id: webhookId, organizationId },
      select: { secret: true, url: true, enabled: true },
    });
    if (!webhook?.secret || !webhook.enabled || !webhook.url) {
      throw new UnrecoverableError('Webhook subscription is unavailable');
    }
    return { secret: webhook.secret, url: webhook.url };
  }

  async process(job: Job<WebhookJobData>): Promise<WebhookJobResult> {
    const jobName = job.name ?? 'webhook-delivery';

    const execute = async (): Promise<WebhookJobResult> => {
      const { webhookId, organizationId, eventName, payload, eventId, metadata } = job.data;
      const requestTrace = metadata?.requestId ? ` requestId=${metadata.requestId}` : '';
      const maxAttempts = job.opts?.attempts ?? this.config.webhookDeliveryMaxAttempts;
      this.logger.debug(
        `Processing webhook ${webhookId} event ${eventName} attempt ${job.attemptsMade + 1}/${maxAttempts}${requestTrace}`,
      );

      let responseStatus: number | undefined;
      let errorMessage: string | undefined;
      let endpoint = job.data.url;
      try {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const subscription = await this.resolveSubscription(webhookId, organizationId);
        endpoint = subscription.url;
        const signature = signWebhookPayload(subscription.secret, timestamp, eventId, body);

        const response = await fetch(subscription.url, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'content-type': 'application/json',
            [WEBHOOK_SIGNATURE_HEADER]: signature,
            [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
            [WEBHOOK_EVENT_ID_HEADER]: eventId,
            [WEBHOOK_DELIVERY_HEADER]: eventId,
            [WEBHOOK_EVENT_HEADER]: eventName,
            [WEBHOOK_SIGNATURE_VERSION_HEADER]: WEBHOOK_SIGNATURE_VERSION,
            'user-agent': 'Astroid-Webhook-Bot/1.0',
          },
          body,
          signal: AbortSignal.timeout(this.config.webhookHttpTimeoutMs),
        });

        responseStatus = response.status;
        if (!response.ok) {
          errorMessage = `HTTP ${response.status}`;
          const isNonTransient =
            response.status >= 300 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429;
          this.logger.warn(`Webhook ${webhookId} responded ${response.status}${requestTrace}`);
          if (isNonTransient) {
            throw new UnrecoverableError(errorMessage);
          }
          throw new Error(errorMessage);
        }
        this.logger.debug(`Webhook ${webhookId} delivered successfully${requestTrace}`);
      } catch (error) {
        if (error instanceof UnrecoverableError) {
          errorMessage = error.message;
          await this.persistState({
            webhookId,
            organizationId,
            eventName,
            eventId,
            payload,
            status: 'FAILED',
            attempts: job.attemptsMade + 1,
            lastError: errorMessage,
            responseStatus,
          });
          await this.auditTerminalFailure(job, errorMessage, responseStatus, endpoint);
          throw error;
        }
        errorMessage =
          responseStatus !== undefined
            ? `HTTP ${responseStatus}`
            : error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
              ? 'Webhook request timed out'
              : 'Webhook request failed';
        const isLastAttempt = job.attemptsMade >= maxAttempts - 1;
        this.logger.error(
          `Webhook ${webhookId} failed attempt ${job.attemptsMade + 1}/${maxAttempts}${requestTrace}`,
        );
        await this.persistState({
          webhookId,
          organizationId,
          eventName,
          eventId,
          payload,
          status: isLastAttempt ? 'FAILED' : 'RETRYING',
          attempts: job.attemptsMade + 1,
          lastError: errorMessage,
          responseStatus,
        });
        if (isLastAttempt) {
          this.logger.error(`Webhook ${webhookId} exhausted all retry attempts${requestTrace}`);
          // Retries are exhausted: the delivery is dead-lettered by the queue
          // failure listener, so record it permanently in the audit trail.
          await this.auditTerminalFailure(job, errorMessage ?? 'unknown error', responseStatus, endpoint);
        }
        throw error;
      }

      await this.persistState({
        webhookId,
        organizationId,
        eventName,
        eventId,
        payload,
        status: 'DELIVERED',
        attempts: job.attemptsMade + 1,
        responseStatus,
      });
      return { success: true, statusCode: responseStatus };
    };

    if (this.workerMetrics) {
      return this.workerMetrics.instrumentJob(Queues.Webhooks, jobName, execute);
    }
    return execute();
  }

  private async persistState(data: {
    webhookId: string;
    organizationId: string;
    eventName: string;
    eventId: string;
    payload: unknown;
    status: 'PENDING' | 'RETRYING' | 'FAILED' | 'DELIVERED';
    attempts: number;
    lastError?: string;
    responseStatus?: number;
  }): Promise<void> {
    if (!this.prisma) return;
    try {
      // Persist through the dedicated worker client so background writes are
      // never aborted by the API-oriented query timeouts (issue #76).
      const client = this.prisma.workerClient ?? this.prisma;
      const prismaAny = client as unknown as Record<string, unknown>;
      const delegate = prismaAny['webhookDelivery'] as
        | { upsert?: (args: unknown) => Promise<unknown> }
        | undefined;
      if (!delegate?.upsert) return;
      await delegate.upsert({
        where: { id: `${data.webhookId}-${data.eventId}` },
        create: {
          id: `${data.webhookId}-${data.eventId}`,
          webhookId: data.webhookId,
          organizationId: data.organizationId,
          eventName: data.eventName,
          eventId: data.eventId,
          payload: data.payload ?? {},
          status: data.status,
          attempts: data.attempts,
          lastError: data.lastError ?? null,
          responseStatus: data.responseStatus ?? null,
        },
        update: {
          status: data.status,
          attempts: data.attempts,
          lastError: data.lastError ?? null,
          responseStatus: data.responseStatus ?? null,
        },
      } as unknown);
    } catch (err) {
      this.logger.warn(`Failed to persist webhook state for ${data.webhookId}: ${(err as Error).message}`);
    }
  }
}
