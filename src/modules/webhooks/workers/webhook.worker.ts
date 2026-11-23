import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';
import { Queues } from '../../../queues/queues.constants';
import { WebhookJobData, WebhookJobResult } from '../types/webhook-job.types';
import { hmacSign } from '../../../utils/crypto.util';
import { PrismaService } from '../../../database/prisma.service';
import { WebhookRetryPolicy, webhookBackoffStrategy } from '../webhook-retry.policy';
import { loadWebhookRetrySettings } from '../../../config/webhook.config';

/**
 * Outbound webhook delivery worker (#550).
 *
 * Retry contract:
 *   - network errors, timeouts, 408, 429 and 5xx are retried
 *   - every other 4xx fails permanently, immediately
 *   - retries follow a capped, jittered backoff schedule (default
 *     30s, 1m, 5m, 15m, 30m; max 6 attempts)
 *   - after the last allowed attempt the delivery is marked
 *     FAILED_PERMANENTLY and copied to the dead-letter queue
 *
 * The persisted `WebhookDelivery` row is authoritative for reporting: every
 * attempt records attempt count, timestamp, status code, error and the next
 * scheduled attempt. The HMAC signing scheme and header names are unchanged so
 * consumers need no changes.
 */
@Processor(Queues.Webhooks, { settings: { backoffStrategy: webhookBackoffStrategy } })
export class WebhookWorker extends WorkerHost {
  private readonly logger = new Logger(WebhookWorker.name);
  private readonly policy: WebhookRetryPolicy;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(Queues.WebhookDeadLetter)
    private readonly deadLetterQueue: Queue<WebhookJobData>,
    @Optional() policy?: WebhookRetryPolicy,
  ) {
    super();
    this.policy = policy ?? new WebhookRetryPolicy(loadWebhookRetrySettings());
  }

  async process(job: Job<WebhookJobData>): Promise<WebhookJobResult> {
    const data = job.data;
    const attempt = job.attemptsMade + 1;
    this.logger.debug(
      `Webhook ${data.webhookId} ${data.eventName} attempt ${attempt}/${this.policy.maxAttempts}`,
    );

    let outcome: { status: number; error?: string } | undefined;
    let networkError: string | undefined;
    try {
      outcome = await this.deliver(data);
    } catch (error) {
      networkError = (error as Error).message;
    }

    if (outcome && outcome.status >= 200 && outcome.status < 300) {
      await this.persist(data, {
        attempt,
        status: WebhookDeliveryStatus.DELIVERED,
        httpStatus: outcome.status,
      });
      return { success: true, statusCode: outcome.status };
    }

    const httpStatus = outcome?.status;
    const errorMessage =
      networkError ?? outcome?.error ?? `HTTP ${httpStatus ?? 'unknown'}`;
    const retryable = httpStatus === undefined || this.policy.isRetryableStatus(httpStatus);
    const canRetry = retryable && this.policy.hasAttemptsRemaining(attempt);

    if (!canRetry) {
      const reason = retryable
        ? `exhausted ${this.policy.maxAttempts} attempts`
        : `non-retryable HTTP ${httpStatus}`;
      this.logger.error(`Webhook ${data.webhookId} permanently failed: ${reason}`);
      await this.persist(data, {
        attempt,
        status: WebhookDeliveryStatus.FAILED_PERMANENTLY,
        httpStatus,
        error: `${errorMessage} (${reason})`,
        deadLettered: true,
      });
      await this.enqueueDeadLetter(job, reason);
      // Prevent BullMQ from scheduling another attempt for this job.
      throw new UnrecoverableError(errorMessage);
    }

    const delayMs = this.policy.computeDelayMs(attempt);
    this.logger.warn(
      `Webhook ${data.webhookId} attempt ${attempt} failed (${errorMessage}); retrying in ${delayMs}ms`,
    );
    await this.persist(data, {
      attempt,
      status: WebhookDeliveryStatus.RETRYING,
      httpStatus,
      error: errorMessage,
      nextAttemptAt: new Date(Date.now() + delayMs),
    });
    throw new Error(errorMessage);
  }

  /** Performs the signed HTTP delivery. Throws on network error/timeout. */
  private async deliver(data: WebhookJobData): Promise<{ status: number; error?: string }> {
    const body = JSON.stringify(data.payload);
    const signature = hmacSign(data.secret, body);

    const response = await fetch(data.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-astroid-signature': signature,
        'x-astroid-event-id': data.eventId,
        'x-astroid-event': data.eventName,
        'user-agent': 'Astroid-Webhook-Bot/1.0',
      },
      body,
      signal: AbortSignal.timeout(this.policy.timeoutMs),
    });

    if (response.ok) {
      return { status: response.status };
    }

    const errorText = await response.text().catch(() => response.statusText);
    return { status: response.status, error: `HTTP ${response.status}: ${errorText}` };
  }

  /** Upserts the delivery record; persistence failures never block the retry. */
  private async persist(
    data: WebhookJobData,
    state: {
      attempt: number;
      status: WebhookDeliveryStatus;
      httpStatus?: number;
      error?: string;
      nextAttemptAt?: Date | null;
      deadLettered?: boolean;
    },
  ): Promise<void> {
    const now = new Date();
    const id = `${data.webhookId}-${data.eventId}`;
    const shared = {
      status: state.status,
      attempts: state.attempt,
      lastStatusCode: state.httpStatus ?? null,
      lastAttemptAt: now,
      nextAttemptAt: state.nextAttemptAt ?? null,
      lastError: state.error ?? null,
      deadLetteredAt: state.deadLettered ? now : null,
    };

    try {
      await this.prisma.webhookDelivery.upsert({
        where: { id },
        create: {
          id,
          webhookId: data.webhookId,
          organizationId: data.organizationId,
          eventName: data.eventName,
          eventId: data.eventId,
          payload: (data.payload ?? {}) as Prisma.InputJsonValue,
          ...shared,
        },
        update: shared,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to persist delivery state for ${data.webhookId}: ${(error as Error).message}`,
      );
    }
  }

  /** Copies a permanently failed delivery to the dead-letter queue. */
  private async enqueueDeadLetter(job: Job<WebhookJobData>, reason: string): Promise<void> {
    try {
      await this.deadLetterQueue.add(
        'webhook-delivery',
        { ...job.data },
        {
          attempts: 1,
          removeOnComplete: { count: 1_000 },
          removeOnFail: { age: 7 * 24 * 3_600 },
        },
      );
      this.logger.warn(`Webhook ${job.data.webhookId} moved to dead-letter queue: ${reason}`);
    } catch (error) {
      this.logger.error(
        `Failed to dead-letter webhook ${job.data.webhookId}: ${(error as Error).message}`,
      );
    }
  }
}
