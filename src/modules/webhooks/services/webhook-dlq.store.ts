import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { DomainEventName } from '../../../events/event-names';
import {
  DeadLetterWebhookRecord,
  WebhookAttemptHistoryEntry,
  WebhookDlqStore,
} from './webhook-dlq.service';

/** Columns every dead-letter listing needs; never the signing secret. */
const DELIVERY_SELECT = {
  id: true,
  organizationId: true,
  webhookId: true,
  eventId: true,
  eventName: true,
  payload: true,
  attempts: true,
  lastError: true,
  failureCode: true,
  responseStatus: true,
  updatedAt: true,
} satisfies Prisma.WebhookDeliverySelect;

type DeliveryRow = Prisma.WebhookDeliveryGetPayload<{ select: typeof DELIVERY_SELECT }>;

/**
 * Durable store behind {@link WebhookDlqService}.
 *
 * A webhook delivery is dead-lettered when it reaches the terminal `FAILED`
 * state — either the retry budget is exhausted or the endpoint rejected it
 * permanently. `webhook_deliveries` therefore already is the inspectable
 * registry of dead-lettered deliveries, and `webhook_delivery_attempts` is its
 * append-only attempt history; this store joins the two instead of creating a
 * second ledger that could drift from the delivery record.
 *
 * Every query is scoped by organization, so one tenant can never inspect or
 * replay another tenant's delivery by guessing an id.
 */
@Injectable()
export class PrismaWebhookDlqStore implements WebhookDlqStore {
  constructor(private readonly prisma: PrismaService) {}

  private static where(organizationId: string): Prisma.WebhookDeliveryWhereInput {
    return { organizationId, status: WebhookDeliveryStatus.FAILED };
  }

  async findManyByOrganization(
    organizationId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: DeadLetterWebhookRecord[]; total: number }> {
    const where = PrismaWebhookDlqStore.where(organizationId);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where,
        select: DELIVERY_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.webhookDelivery.count({ where }),
    ]);

    return { items: rows.map((row) => this.toRecord(row)), total };
  }

  async findById(organizationId: string, id: string): Promise<DeadLetterWebhookRecord | null> {
    const row = await this.prisma.webhookDelivery.findFirst({
      where: { id, ...PrismaWebhookDlqStore.where(organizationId) },
      select: DELIVERY_SELECT,
    });
    if (!row) return null;

    return this.toRecord(row, await this.loadAttemptHistory(row));
  }

  /**
   * Records the replay in the append-only domain-event ledger and returns the
   * delivery with its replay timestamp. The delivery row itself is left as
   * `FAILED`: it stays the historical record of why the delivery failed, while
   * the replayed job reports its own outcome.
   */
  async markReplayed(id: string, replayedAt: Date): Promise<DeadLetterWebhookRecord> {
    const row = await this.prisma.webhookDelivery.findUnique({
      where: { id },
      select: DELIVERY_SELECT,
    });
    if (!row) {
      throw new NotFoundException(`Dead-letter webhook record ${id} not found`);
    }

    await this.prisma.domainEvent.create({
      data: {
        organizationId: row.organizationId,
        name: DomainEventName.JobRequeued,
        aggregateType: 'webhook',
        aggregateId: row.id,
        payload: {
          queue: 'webhooks',
          deliveryId: row.id,
          webhookId: row.webhookId,
          eventId: row.eventId,
          replayedAt: replayedAt.toISOString(),
        } as Prisma.InputJsonValue,
        occurredAt: replayedAt,
      },
    });

    return this.toRecord(row, await this.loadAttemptHistory(row), replayedAt);
  }

  private async loadAttemptHistory(row: DeliveryRow): Promise<WebhookAttemptHistoryEntry[]> {
    const attempts = await this.prisma.webhookDeliveryAttempt.findMany({
      where: { webhookId: row.webhookId, eventId: row.eventId },
      orderBy: [{ attemptNumber: 'asc' }, { createdAt: 'asc' }],
      take: 20,
    });

    return attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      responseStatus: attempt.responseStatus,
      errorCode: attempt.errorCode,
      errorMessage: attempt.errorMessage,
      durationMs: attempt.durationMs,
      createdAt: attempt.createdAt,
    }));
  }

  private toRecord(
    row: DeliveryRow,
    attemptHistory?: WebhookAttemptHistoryEntry[],
    replayedAt?: Date,
  ): DeadLetterWebhookRecord {
    const payload =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};

    return {
      id: row.id,
      organizationId: row.organizationId,
      webhookId: row.webhookId,
      eventId: row.eventId,
      eventType: row.eventName,
      payload,
      attemptsMade: row.attempts,
      lastError: row.lastError ?? row.failureCode ?? 'Delivery failed',
      ...(row.responseStatus === null ? {} : { statusCode: row.responseStatus }),
      failedAt: row.updatedAt,
      replayedAt: replayedAt ?? null,
      ...(attemptHistory ? { attemptHistory } : {}),
    };
  }
}
