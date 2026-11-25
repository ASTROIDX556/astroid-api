import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

import { DlqJobData, Queues } from '../../../queues/queues.constants';
import { buildDeadLetterJobId } from '../../../queues/dlq';
import { PrismaService } from '../../../database/prisma.service';
import { scrubString } from '../../../utils/log-scrubber.util';
import { WebhookJobData } from '../types/webhook-job.types';

/** Why the delivery was abandoned, as observed by the worker. */
export interface WebhookDeadLetterFailure {
  failedReason: string;
  /** Attempts consumed, including the one that just failed. */
  attemptsMade: number;
  responseStatus?: number;
  failureCategory?: string;
  failureCode?: string;
}

/** One attempt row, copied into the dead-letter entry so it survives retention. */
export interface WebhookAttemptSnapshot {
  attemptNumber: number;
  status: string;
  responseStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
  createdAt: string;
}

/** Identifiers a dead-lettered delivery is inspected by. */
export interface WebhookDeadLetterIdentifiers {
  webhookId: string;
  organizationId: string;
  eventName: string;
  eventId: string;
}

/**
 * Routes an exhausted webhook delivery onto the dead-letter queue.
 *
 * This is the delivery worker's own dead-letter path: when the last configured
 * attempt fails — or a permanent rejection rules out a retry — the worker writes
 * one dead-letter entry carrying the failure reason, the attempt count, the
 * delivery identifiers and the append-only attempt history read from
 * `webhook_delivery_attempts`. The global `QueueFailureListener` keeps the same
 * entry id, so its own observation of the terminal `failed` event is ignored
 * instead of duplicating the record.
 *
 * Writing the entry is best-effort: a Redis or database hiccup is logged and
 * swallowed, so bookkeeping can never mask the delivery failure or crash the
 * worker.
 */
@Injectable()
export class WebhookDeadLetterService {
  private readonly logger = new Logger(WebhookDeadLetterService.name);

  /** Attempts copied into one dead-letter entry, newest last. */
  private static readonly MAX_ATTEMPT_HISTORY = 20;

  constructor(
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
    @Optional() @InjectQueue(Queues.DeadLetter)
    private readonly deadLetterQueue?: Queue<DlqJobData>,
  ) {}

  /** Writes the dead-letter entry for a delivery that will not be retried again. */
  async recordTerminalFailure(
    job: Job<WebhookJobData>,
    failure: WebhookDeadLetterFailure,
  ): Promise<void> {
    if (!this.deadLetterQueue || !job.id) {
      this.logger.warn(
        `Could not dead-letter webhook ${job.data.webhookId}: the dead-letter queue is unavailable`,
      );
      return;
    }

    const identifiers: WebhookDeadLetterIdentifiers = {
      webhookId: job.data.webhookId,
      organizationId: job.data.organizationId,
      eventName: job.data.eventName,
      eventId: job.data.eventId,
    };

    try {
      const attemptHistory = await this.loadAttemptHistory(identifiers);
      const data: DlqJobData = {
        originalQueue: Queues.Webhooks,
        originalJobId: job.id,
        originalJobName: job.name,
        // Only identifiers are copied: the event payload carries tenant data and
        // stays in `webhook_deliveries`, which the operator can look up by event.
        payload: identifiers,
        failedReason: scrubString(failure.failedReason),
        stacktrace: [],
        attemptsMade: failure.attemptsMade,
        failedAt: new Date().toISOString(),
        metadata: {
          subscriptionId: identifiers.webhookId,
          ...identifiers,
          ...(failure.responseStatus === undefined
            ? {}
            : { responseStatus: failure.responseStatus }),
          ...(failure.failureCategory ? { failureCategory: failure.failureCategory } : {}),
          ...(failure.failureCode ? { failureCode: failure.failureCode } : {}),
          attemptHistory,
        },
      };

      await this.deadLetterQueue.add(`dlq:${Queues.Webhooks}:${job.id}`, data, {
        // Idempotent: the queue failure listener uses the same id for this job.
        jobId: buildDeadLetterJobId(Queues.Webhooks, job.id),
        removeOnComplete: { count: 5_000 },
        removeOnFail: { age: 7 * 24 * 3_600, count: 5_000 },
      });
      this.logger.error(
        `Webhook ${identifiers.webhookId} event ${identifiers.eventId} dead-lettered after ${failure.attemptsMade} attempts: ${scrubString(failure.failedReason)}`,
      );
    } catch (error) {
      this.logger.error(
        `Could not dead-letter webhook ${identifiers.webhookId}: ${scrubString((error as Error).message)}`,
      );
    }
  }

  /** Reads the append-only attempt history for one delivery, best-effort. */
  private async loadAttemptHistory(
    identifiers: WebhookDeadLetterIdentifiers,
  ): Promise<WebhookAttemptSnapshot[]> {
    if (!this.prisma) return [];
    try {
      const client = this.prisma.workerClient ?? this.prisma;
      const rows = await client.webhookDeliveryAttempt.findMany({
        where: {
          webhookId: identifiers.webhookId,
          eventId: identifiers.eventId,
        },
        orderBy: [{ attemptNumber: 'asc' }, { createdAt: 'asc' }],
        take: WebhookDeadLetterService.MAX_ATTEMPT_HISTORY,
      });
      return rows.map((row) => ({
        attemptNumber: row.attemptNumber,
        status: row.status,
        responseStatus: row.responseStatus,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        durationMs: row.durationMs,
        createdAt: row.createdAt.toISOString(),
      }));
    } catch (error) {
      this.logger.warn(
        `Could not load webhook attempt history for ${identifiers.eventId}: ${scrubString((error as Error).message)}`,
      );
      return [];
    }
  }
}
