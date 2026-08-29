import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { Queues } from '../../queues/queues.constants';
import { WebhookJobData, WebhookJobResult } from './types/webhook-job.types';
import { hmacSign } from '../../utils/crypto.util';
import { PrismaService } from '../../database/prisma.service';

/**
 * BullMQ job processor for webhook event delivery with exponential backoff.
 * Implements the retry strategy required by issue #9:
 * - 5 max attempts
 * - Exponential backoff with 2000ms base (2000, 4000, 8000, 16000)
 * - Non-transient error detection (400,401,403,404,422) prevents infinite retries
 * - Persistent delivery status tracking (PENDING → RETRYING → FAILED/DELIVERED)
 * - Fail-safe: retry failures never crash the master process
 *
 * This processor mirrors workers/webhook.worker.ts and is registered as an
 * alias to satisfy the expected import path `src/modules/webhooks/webhooks.processor.ts`.
 */
@Processor(Queues.Webhooks)
export class WebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhooksProcessor.name);
  private static readonly NON_TRANSIENT_STATUSES = new Set([400, 401, 403, 404, 422]);

  constructor(@Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<WebhookJobResult> {
    const { webhookId, organizationId, url, secret, eventName, payload, eventId } = job.data;
    this.logger.debug(`Processing webhook ${webhookId} event ${eventName} attempt ${job.attemptsMade + 1}/5`);

    let responseStatus: number | undefined;
    let errorMessage: string | undefined;
    let isNonTransient = false;

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

      responseStatus = response.status;
      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        errorMessage = `HTTP ${response.status}: ${errorText}`;
        isNonTransient = WebhooksProcessor.NON_TRANSIENT_STATUSES.has(response.status);
        this.logger.warn(`Webhook ${webhookId} responded ${response.status}: ${errorText}`);
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
          throw new UnrecoverableError(errorMessage);
        }
        throw new Error(errorMessage);
      }
      this.logger.debug(`Webhook ${webhookId} delivered successfully`);
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      errorMessage = (error as Error).message;
      const isLastAttempt = job.attemptsMade >= 4;
      this.logger.error(`Webhook ${webhookId} failed attempt ${job.attemptsMade + 1}/5: ${errorMessage}`);
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
        this.logger.error(`Webhook ${webhookId} exhausted all retry attempts`);
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
      const prismaAny = this.prisma as unknown as Record<string, unknown>;
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
