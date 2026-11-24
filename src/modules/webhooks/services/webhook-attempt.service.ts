import { Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../../../database/prisma.service';

/** One HTTP attempt of a webhook delivery. */
export interface WebhookDeliveryAttemptInput {
  webhookId: string;
  organizationId: string;
  eventId: string;
  /** 1-based attempt index within the delivery. */
  attemptNumber: number;
  status: 'SUCCEEDED' | 'FAILED';
  responseStatus?: number;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Appends one row to `webhook_delivery_attempts` per HTTP attempt.
 *
 * Persistence is best-effort: a delivery must never fail because its audit row
 * could not be written, so errors are logged and swallowed. Error messages are
 * bounded before storage to keep a misbehaving endpoint from bloating the table.
 */
@Injectable()
export class WebhookAttemptService {
  private readonly logger = new Logger(WebhookAttemptService.name);
  private static readonly MAX_ERROR_LENGTH = 1_000;

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async record(attempt: WebhookDeliveryAttemptInput): Promise<void> {
    if (!this.prisma) return;
    try {
      const client = this.prisma.workerClient ?? this.prisma;
      await client.webhookDeliveryAttempt.create({
        data: {
          webhookId: attempt.webhookId,
          organizationId: attempt.organizationId,
          eventId: attempt.eventId,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          responseStatus: attempt.responseStatus ?? null,
          durationMs: Math.max(0, Math.round(attempt.durationMs)),
          errorCode: attempt.errorCode?.slice(0, 120) ?? null,
          errorMessage: attempt.errorMessage
            ? attempt.errorMessage.slice(0, WebhookAttemptService.MAX_ERROR_LENGTH)
            : null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not persist webhook attempt ${attempt.attemptNumber} for ${attempt.webhookId}: ${(error as Error).message}`,
      );
    }
  }
}
