import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';

import { DomainEventName } from '../../../events/event-names';
import { PrismaWebhookDlqStore } from './webhook-dlq.store';

describe('PrismaWebhookDlqStore', () => {
  const findMany = vi.fn();
  const count = vi.fn();
  const findFirst = vi.fn();
  const findUnique = vi.fn();
  const attemptsFindMany = vi.fn();
  const domainEventCreate = vi.fn();

  const row = {
    id: 'delivery-1',
    organizationId: 'org-1',
    webhookId: 'wh-1',
    eventId: 'evt-1',
    eventName: 'transaction.completed',
    payload: { event: 'transaction.completed', data: { id: 'txn-1' } },
    attempts: 5,
    lastError: 'HTTP 503',
    failureCode: 'HTTP_503',
    responseStatus: 503,
    updatedAt: new Date('2026-01-15T10:00:00.000Z'),
  };

  const store = () =>
    new PrismaWebhookDlqStore({
      $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
      webhookDelivery: { findMany, count, findFirst, findUnique },
      webhookDeliveryAttempt: { findMany: attemptsFindMany },
      domainEvent: { create: domainEventCreate },
    } as never);

  beforeEach(() => {
    findMany.mockReset().mockResolvedValue([row]);
    count.mockReset().mockResolvedValue(1);
    findFirst.mockReset().mockResolvedValue(row);
    findUnique.mockReset().mockResolvedValue(row);
    attemptsFindMany.mockReset().mockResolvedValue([
      {
        attemptNumber: 1,
        status: 'FAILED',
        responseStatus: 503,
        errorCode: 'HTTP_503',
        errorMessage: 'HTTP 503',
        durationMs: 12,
        createdAt: new Date('2026-01-15T10:00:00.000Z'),
      },
    ]);
    domainEventCreate.mockReset().mockResolvedValue({ id: 'evt-log-1' });
  });

  it('lists only failed deliveries for the caller organization', async () => {
    const result = await store().findManyByOrganization('org-1', 20, 10);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1', status: 'FAILED' },
        skip: 20,
        take: 10,
      }),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: 'delivery-1',
      webhookId: 'wh-1',
      eventId: 'evt-1',
      eventType: 'transaction.completed',
      attemptsMade: 5,
      lastError: 'HTTP 503',
      statusCode: 503,
      replayedAt: null,
    });
  });

  it('returns null when the delivery is not a dead letter of that organization', async () => {
    findFirst.mockResolvedValueOnce(null);

    await expect(store().findById('org-1', 'delivery-1')).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery-1', organizationId: 'org-1', status: 'FAILED' },
      }),
    );
  });

  it('attaches the append-only attempt history when inspecting one delivery', async () => {
    const record = await store().findById('org-1', 'delivery-1');

    expect(attemptsFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { webhookId: 'wh-1', eventId: 'evt-1' } }),
    );
    expect(record?.attemptHistory).toEqual([
      expect.objectContaining({ attemptNumber: 1, status: 'FAILED', responseStatus: 503 }),
    ]);
  });

  it('records the replay in the ledger and returns the replay timestamp', async () => {
    const replayedAt = new Date('2026-01-15T11:00:00.000Z');

    const record = await store().markReplayed('delivery-1', replayedAt);

    expect(domainEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        name: DomainEventName.JobRequeued,
        aggregateType: 'webhook',
        aggregateId: 'delivery-1',
        payload: expect.objectContaining({ queue: 'webhooks', deliveryId: 'delivery-1' }),
      }),
    });
    expect(record.replayedAt).toBe(replayedAt);
  });

  it('throws when the delivery to record as replayed no longer exists', async () => {
    findUnique.mockResolvedValueOnce(null);

    await expect(store().markReplayed('missing', new Date())).rejects.toThrow(
      NotFoundException,
    );
    expect(domainEventCreate).not.toHaveBeenCalled();
  });
});
