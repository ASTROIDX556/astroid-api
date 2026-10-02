import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { Queues } from '../../queues/queues.constants';
import { WebhookJobData, WebhookJobResult } from './types/webhook-job.types';
import { signWebhookPayload, WEBHOOK_SIGNATURE_VERSION } from './utils/signing';
import { PrismaService } from '../../database/prisma.service';
import { WorkerMetricsService } from '../../modules/metrics/worker-metrics.service';
import { WebhookAuditService } from './services/webhook-audit.service';
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
 * Implements the retry strategy required by issue #125:
 * - 5 max attempts
 * - Exponential backoff with 2000ms base and 20% randomized jitter
 *   (prevents thundering herd against subscriber endpoints)
 * - Non-transient error detection (400,401,403,404,422) prevents infinite retries
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
  private static readonly NON_TRANSIENT_STATUSES = new Set([400, 401, 403, 404, 422]);

  constructor(
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
    @Optional() private readonly webhookAudit?: WebhookAuditService,
  ) {
    super();
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
  ): Promise<void> {
    if (!this.webhookAudit) return;
    try {
      await this.webhookAudit.recordTerminalFailure({
        webhookId: job.data.webhookId,
        organizationId: job.data.organizationId,
        url: job.data.url,
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

  private async resolveSecret(webhookId: string, organizationId: string): Promise<string> {
    const client = this.prisma?.workerClient ?? this.prisma;
    if (!client) throw new UnrecoverableError('Webhook signing secret is unavailable');
    const webhook = await client.webhook.findFirst({
      where: { id: webhookId, organizationId },
      select: { secret: true },
    });
    if (!webhook?.secret) throw new UnrecoverableError('Webhook signing secret is unavailable');
    return webhook.secret;
  }

  async process(job: Job<WebhookJobData>): Promise<WebhookJobResult> {
    const jobName = job.name ?? 'webhook-delivery';

    const execute = async (): Promise<WebhookJobResult> => {
      const { webhookId, organizationId, url, eventName, payload, eventId, metadata } = job.data;
      const requestTrace = metadata?.requestId ? ` requestId=${metadata.requestId}` : '';
      this.logger.debug(`Processing webhook ${webhookId} event ${eventName} attempt ${job.attemptsMade + 1}/5${requestTrace}`);

      let responseStatus: number | undefined;
      let errorMessage: string | undefined;
      let isNonTransient = false;

      try {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const effectiveSecret = await this.resolveSecret(webhookId, organizationId);
        const signature = signWebhookPayload(effectiveSecret, timestamp, eventId, body);

        const response = await fetch(url, {
          method: 'POST',
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
          signal: AbortSignal.timeout(5000),
        });

        responseStatus = response.status;
        if (!response.ok) {
          errorMessage = `HTTP ${response.status}`;
          isNonTransient = WebhooksProcessor.NON_TRANSIENT_STATUSES.has(response.status);
          this.logger.warn(`Webhook ${webhookId} responded ${response.status}${requestTrace}`);
          if (isNonTransient) {
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
            // Non-transient (4xx): record the abandoned delivery before BullMQ
            // moves it straight to the failed set.
            await this.auditTerminalFailure(job, errorMessage ?? 'HTTP error', responseStatus);
            throw new UnrecoverableError(errorMessage);
          }
          throw new Error(errorMessage);
        }
        this.logger.debug(`Webhook ${webhookId} delivered successfully${requestTrace}`);
      } catch (error) {
        if (error instanceof UnrecoverableError) throw error;
        errorMessage = error instanceof UnrecoverableError ? error.message : 'Delivery attempt failed';
        const isLastAttempt = job.attemptsMade >= 4;
        this.logger.error(`Webhook ${webhookId} failed attempt ${job.attemptsMade + 1}/5${requestTrace}`);
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
          await this.auditTerminalFailure(job, errorMessage ?? 'unknown error', responseStatus);
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

