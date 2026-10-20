import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookCircuitStatus } from '@prisma/client';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';
import { PermanentJobError, RetryableJobError } from '../../queues/queue-policy';
import { Queues } from '../../queues/queues.constants';
import { WebhookJobData, WebhookJobResult } from './types/webhook-job.types';
import { signWebhookPayload, WEBHOOK_SIGNATURE_VERSION } from './utils/signing';
import { PrismaService } from '../../database/prisma.service';
import { WorkerMetricsService } from '../../modules/metrics/worker-metrics.service';
import { WebhookAuditService } from './services/webhook-audit.service';
import { WebhookCircuitService } from './services/webhook-circuit.service';
import {
  NON_TRANSIENT_WEBHOOK_STATUSES,
  WebhookFailureCategory,
  classifyWebhookFailure,
} from './utils/failure-classification';
import { webhookRetryDelayMs } from '../../queues/webhook.queue';
import { DomainEventName } from '../../events/event-names';
import { EventBusService } from '../../events/event-bus.service';
import { DEFAULT_WEBHOOK_CONFIG, WebhookConfig } from '../../config/webhook.config';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../../common/constants/headers';
import {
  WebhookDestinationClient,
  WebhookDestinationError,
  WebhookDestinationPolicy,
  WebhookDestinationResolutionError,
} from './webhook-destination.policy';

/** How often a deferred delivery is moved back into the delayed set. */
const CIRCUIT_DEFERRAL_ATTEMPTS = 3;

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
 * queue.opts.settings.backoffStrategy at retry time. The delay is capped by
 * `WEBHOOK_BACKOFF_MAX_DELAY_MS` so a retry is never scheduled further away
 * than the configured ceiling.
 *
 * On top of the retry policy, a per-endpoint circuit breaker (issue #442)
 * protects a failing subscriber: after `WEBHOOK_CIRCUIT_FAILURE_THRESHOLD`
 * consecutive failed attempts the circuit opens and further deliveries are
 * deferred — without consuming an attempt — until the cooldown ends. A single
 * probe delivery then decides whether the circuit closes again.
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
  constructor(
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
    @Optional() private readonly workerMetrics?: WorkerMetricsService,
    @Optional() private readonly webhookAudit?: WebhookAuditService,
    @Optional() @Inject(WebhookDestinationPolicy)
    private readonly destinationPolicy: WebhookDestinationClient = new WebhookDestinationPolicy(),
    @Optional() private readonly circuit?: WebhookCircuitService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly eventBus?: EventBusService,
  ) {
    super();
  }

  /** The resolved webhook delivery configuration. */
  private get settings(): WebhookConfig {
    return (
      this.config?.get<WebhookConfig>('webhook') ?? DEFAULT_WEBHOOK_CONFIG
    );
  }

  /** The number of attempts a delivery gets before it is dead-lettered. */
  private get maxAttempts(): number {
    return this.settings.maxAttempts;
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
    if (!client) throw new PermanentJobError('Webhook signing secret is unavailable');
    const webhook = await client.webhook.findFirst({
      where: { id: webhookId, organizationId },
      select: { secret: true },
    });
    if (!webhook?.secret) throw new PermanentJobError('Webhook signing secret is unavailable');
    return webhook.secret;
  }

  async process(job: Job<WebhookJobData>): Promise<WebhookJobResult> {
    const jobName = job.name ?? 'webhook-delivery';
    const { webhookId, organizationId, url, eventName, payload, eventId, metadata } = job.data;
    const requestTrace = metadata?.requestId ? ` requestId=${metadata.requestId}` : '';

    // The circuit gate runs before the delivery is attempted: while the
    // endpoint's circuit is open the delivery is deferred instead of sent, so
    // a dead endpoint is never hammered and no attempt budget is consumed.
    const circuitStatus = await this.gateOnCircuit(
      job,
      webhookId,
      organizationId,
      eventName,
      eventId,
      payload,
      requestTrace,
    );

    const execute = async (): Promise<WebhookJobResult> => {
      this.logger.debug(
        `Processing webhook ${webhookId} event ${eventName} attempt ${job.attemptsMade + 1}/${this.maxAttempts}${requestTrace}`,
      );

      let responseStatus: number | undefined;
      let errorMessage: string | undefined;
      let isNonTransient = false;

      try {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const effectiveSecret = await this.resolveSecret(webhookId, organizationId);
        const signature = signWebhookPayload(effectiveSecret, timestamp, eventId, body);

        const response = await this.destinationPolicy.post(url, {
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
          timeoutMs: this.settings.requestTimeoutMs,
        });

        responseStatus = response.status;
        if (response.status < 200 || response.status >= 300) {
          const isRedirect = response.status >= 300 && response.status < 400;
          errorMessage = isRedirect ? 'Webhook endpoint redirects are not supported' : `HTTP ${response.status}`;
          isNonTransient = isRedirect || NON_TRANSIENT_WEBHOOK_STATUSES.has(response.status);
          this.logger.warn(`Webhook ${webhookId} responded ${response.status}${requestTrace}`);
          if (isNonTransient) {
            const classification = classifyWebhookFailure(new Error(errorMessage), responseStatus);
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
              failure: classification,
            });
            await this.recordCircuitFailure(webhookId, organizationId, url, {
              code: classification.code,
              category: WebhookFailureCategory.Permanent,
              reason: errorMessage,
              responseStatus,
            });
            // Non-transient (4xx): record the abandoned delivery before BullMQ
            // moves it straight to the failed set.
            await this.auditTerminalFailure(job, errorMessage ?? 'HTTP error', responseStatus);
            await this.emitTerminalDeliveryFailure(
              job,
              errorMessage ?? 'HTTP error',
              responseStatus,
              {
                category: WebhookFailureCategory.Permanent,
                code: classification.code,
              },
              circuitStatus,
            );
            throw new PermanentJobError(errorMessage);
          }
          throw new Error(errorMessage);
        }
        this.logger.debug(`Webhook ${webhookId} delivered successfully${requestTrace}`);
      } catch (error) {
        if (error instanceof UnrecoverableError) throw error;
        if (error instanceof WebhookDestinationError) {
          errorMessage = error.message;
          const classification = classifyWebhookFailure(error);
          await this.persistState({
            webhookId,
            organizationId,
            eventName,
            eventId,
            payload,
            status: 'FAILED',
            attempts: job.attemptsMade + 1,
            lastError: errorMessage,
            failure: classification,
          });
          await this.recordCircuitFailure(webhookId, organizationId, url, {
            code: classification.code,
            category: WebhookFailureCategory.Permanent,
            reason: errorMessage,
          });
          await this.auditTerminalFailure(job, errorMessage);
          await this.emitTerminalDeliveryFailure(
            job,
            errorMessage,
            undefined,
            {
              category: WebhookFailureCategory.Permanent,
              code: classification.code,
            },
            circuitStatus,
          );
          throw new PermanentJobError(errorMessage);
        }
        errorMessage = error instanceof WebhookDestinationResolutionError
          ? error.message
          : error instanceof Error && /^HTTP \d{3}$/.test(error.message)
            ? error.message
            : 'Webhook delivery failed';
        const classification = classifyWebhookFailure(error, responseStatus);
        const isLastAttempt = job.attemptsMade >= this.maxAttempts - 1;
        this.logger.error(
          `Webhook ${webhookId} failed attempt ${job.attemptsMade + 1}/${this.maxAttempts}${requestTrace}`,
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
          failure: classification,
          nextRetryAt: isLastAttempt
            ? undefined
            : new Date(Date.now() + webhookRetryDelayMs(job.attemptsMade, this.settings)),
        });
        await this.recordCircuitFailure(webhookId, organizationId, url, {
          code: classification.code,
          category: classification.category,
          reason: errorMessage,
          responseStatus,
        });
        if (isLastAttempt) {
          this.logger.error(`Webhook ${webhookId} exhausted all retry attempts${requestTrace}`);
          // Retries are exhausted: the delivery is dead-lettered by the queue
          // failure listener, so record it permanently in the audit trail.
          await this.auditTerminalFailure(job, errorMessage ?? 'unknown error', responseStatus);
          await this.emitTerminalDeliveryFailure(
            job,
            errorMessage ?? 'unknown error',
            responseStatus,
            {
              category: classification.category,
              code: classification.code,
            },
            circuitStatus,
          );
        }
        throw new Error(errorMessage);
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
      await this.recordCircuitSuccess(webhookId, organizationId, url);
      return { success: true, statusCode: responseStatus };
    };

    if (this.workerMetrics) {
      return this.workerMetrics.instrumentJob(Queues.Webhooks, jobName, execute);
    }
    return execute();
  }

  /**
   * Defers the delivery while the endpoint's circuit is open.
   *
   * The job is moved back into BullMQ's delayed set, which does not consume an
   * attempt: the delivery survives the outage and is retried as soon as the
   * cooldown ends. When the job cannot be moved (no worker token, or the queue
   * rejected the move) the delivery falls back to a retryable error so the
   * regular backoff takes over.
   *
   * @returns the state the circuit was in when the decision was taken, so the
   *          terminal delivery event can report it.
   */
  private async gateOnCircuit(
    job: Job<WebhookJobData>,
    webhookId: string,
    organizationId: string,
    eventName: string,
    eventId: string,
    payload: unknown,
    requestTrace: string,
  ): Promise<WebhookCircuitStatus | undefined> {
    if (!this.circuit?.enabled) {
      return undefined;
    }

    const decision = await this.circuit.beforeAttempt(webhookId);
    if (decision.allowed) {
      return decision.status;
    }

    const retryAt = decision.retryAt ?? new Date(Date.now() + this.settings.circuitCooldownMs);
    this.logger.warn(
      `Webhook ${webhookId} is paused: the circuit is open until ${retryAt.toISOString()}${requestTrace}`,
    );

    await this.persistState({
      webhookId,
      organizationId,
      eventName,
      eventId,
      payload,
      status: 'RETRYING',
      // No attempt was made: the delivery was deferred, not sent.
      attempts: job.attemptsMade,
      lastError: 'Webhook circuit is open; the delivery was deferred',
      failure: {
        category: WebhookFailureCategory.CircuitOpen,
        code: 'CIRCUIT_OPEN',
        transient: true,
      },
      nextRetryAt: retryAt,
    });

    // `job.token` is the lock token the worker holds; without it the job
    // cannot be moved back into the delayed set.
    if (job.token) {
      const moved = await this.deferJob(job, retryAt, webhookId);
      if (moved) {
        // `DelayedError` tells BullMQ the job was rescheduled on purpose: it
        // is neither failed nor counted as an attempt.
        throw new DelayedError();
      }
    }

    throw new RetryableJobError(
      `Webhook circuit for '${webhookId}' is open until ${retryAt.toISOString()}`,
    );
  }

  /**
   * Moves the job back into BullMQ's delayed set.
   *
   * The move is retried a few times because a transient Redis error must not
   * turn a deferral into a lost delivery. BullMQ moves the job with
   * `skipAttempt`, so a successful move never consumes an attempt.
   *
   * @returns true when the job was rescheduled.
   */
  private async deferJob(
    job: Job<WebhookJobData>,
    retryAt: Date,
    webhookId: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= CIRCUIT_DEFERRAL_ATTEMPTS; attempt += 1) {
      try {
        await job.moveToDelayed(retryAt.getTime(), job.token);
        return true;
      } catch (error) {
        this.logger.warn(
          `Could not defer the webhook delivery for ${webhookId} (attempt ${attempt}/${CIRCUIT_DEFERRAL_ATTEMPTS}): ${(error as Error).message}`,
        );
      }
    }
    return false;
  }

  /** Records a failed attempt against the endpoint's circuit. */
  private async recordCircuitFailure(
    webhookId: string,
    organizationId: string,
    url: string,
    failure: {
      code: string;
      category: WebhookFailureCategory;
      reason: string;
      responseStatus?: number;
    },
  ): Promise<void> {
    if (!this.circuit?.enabled) {
      return;
    }
    try {
      await this.circuit.recordFailure(webhookId, organizationId, failure, url);
    } catch (error) {
      // The circuit bookkeeping must never mask the delivery failure.
      this.logger.warn(
        `Could not record the webhook circuit failure for ${webhookId}: ${(error as Error).message}`,
      );
    }
  }

  /** Records a successful delivery, which closes an open circuit. */
  private async recordCircuitSuccess(
    webhookId: string,
    organizationId: string,
    url: string,
  ): Promise<void> {
    if (!this.circuit?.enabled) {
      return;
    }
    try {
      await this.circuit.recordSuccess(webhookId, organizationId, url);
    } catch (error) {
      this.logger.warn(
        `Could not record the webhook circuit success for ${webhookId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Emits the domain event that reports the terminal state of a delivery.
   *
   * The event is not written to the domain-event ledger: the compliance
   * record of a terminal failure is the audit entry written by
   * {@link WebhookAuditService}.
   */
  private async emitTerminalDeliveryFailure(
    job: Job<WebhookJobData>,
    failedReason: string,
    responseStatus: number | undefined,
    failure: { category: WebhookFailureCategory; code: string },
    circuitStatus?: WebhookCircuitStatus,
  ): Promise<void> {
    if (!this.eventBus) {
      return;
    }
    try {
      await this.eventBus.emit(
        DomainEventName.WebhookDeliveryFailed,
        {
          webhookId: job.data.webhookId,
          eventName: job.data.eventName,
          eventId: job.data.eventId,
          attemptsMade: job.attemptsMade + 1,
          failedReason,
          responseStatus: responseStatus ?? null,
          failureCategory: failure.category,
          failureCode: failure.code,
          circuitStatus: circuitStatus ?? null,
        },
        {
          organizationId: job.data.organizationId,
          aggregateType: 'webhook',
          aggregateId: job.data.webhookId,
          persist: false,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not emit the webhook delivery failure event: ${(error as Error).message}`,
      );
    }
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
    /** Structured classification of the failure that caused this state. */
    failure?: { category: WebhookFailureCategory; code: string; transient: boolean };
    /** When the next attempt is scheduled. */
    nextRetryAt?: Date;
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
      const now = new Date();
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
          failureCategory: data.failure?.category ?? null,
          failureCode: data.failure?.code ?? null,
          lastAttemptAt: now,
          nextRetryAt: data.nextRetryAt ?? null,
        },
        update: {
          status: data.status,
          attempts: data.attempts,
          lastError: data.lastError ?? null,
          responseStatus: data.responseStatus ?? null,
          failureCategory: data.failure?.category ?? null,
          failureCode: data.failure?.code ?? null,
          lastAttemptAt: now,
          nextRetryAt: data.nextRetryAt ?? null,
        },
      } as unknown);
    } catch (err) {
      this.logger.warn(`Failed to persist webhook state for ${data.webhookId}: ${(err as Error).message}`);
    }
  }
}

