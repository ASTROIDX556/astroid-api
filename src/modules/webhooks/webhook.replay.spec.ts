import { describe, it, expect, vi } from 'vitest';
import { WebhookDeliveryStatus } from '@prisma/client';
import { WebhookService } from './webhook.service';
import { WebhookRepository } from './webhook.repository';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhookDestinationPolicy } from './webhook-destination.policy';

/**
 * Dead-letter inspection and manual replay: listing with a status filter,
 * replaying exactly once, and refusing anything that is not a dead letter.
 */
describe('WebhookService dead-letter replay', () => {
  const delivery = {
    id: 'delivery-1',
    webhookId: 'wh-1',
    organizationId: 'org-1',
    eventName: 'transaction.completed',
    eventId: 'evt-1',
    payload: { event: 'transaction.completed', data: { transactionId: 'txn-1' } },
    status: WebhookDeliveryStatus.DEAD_LETTER,
    attempts: 5,
    lastError: 'HTTP 503',
    responseStatus: 503,
    failureCategory: 'transient',
    failureCode: 'HTTP_503',
    lastAttemptAt: new Date(),
    nextRetryAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    webhook: { url: 'https://partner.example.com/hooks/astroid' },
  };

  const build = (overrides: { status?: WebhookDeliveryStatus; claim?: number } = {}) => {
    const repository = {
      findDeliveryById: vi.fn().mockResolvedValue({
        ...delivery,
        status: overrides.status ?? WebhookDeliveryStatus.DEAD_LETTER,
      }),
      claimDeadLetterForReplay: vi.fn().mockResolvedValue(overrides.claim ?? 1),
      restoreDeadLetter: vi.fn().mockResolvedValue(undefined),
      findDeliveryPage: vi.fn().mockResolvedValue([]),
    };
    const deliveryService = { queueDelivery: vi.fn().mockResolvedValue(undefined) };
    const service = new WebhookService(
      repository as unknown as WebhookRepository,
      { validate: vi.fn() } as unknown as WebhookDestinationPolicy,
      undefined,
      deliveryService as unknown as WebhookDeliveryService,
    );
    return { repository, deliveryService, service };
  };

  it('re-enqueues a dead-lettered delivery exactly once', async () => {
    const { repository, deliveryService, service } = build();

    const result = await service.replayDeadLetterDelivery('org-1', 'delivery-1');

    expect(repository.claimDeadLetterForReplay).toHaveBeenCalledWith('org-1', 'delivery-1');
    expect(deliveryService.queueDelivery).toHaveBeenCalledTimes(1);
    expect(deliveryService.queueDelivery).toHaveBeenCalledWith({
      webhookId: 'wh-1',
      organizationId: 'org-1',
      url: 'https://partner.example.com/hooks/astroid',
      eventName: 'transaction.completed',
      eventId: 'evt-1',
      payload: delivery.payload,
    });
    expect(result).toMatchObject({
      id: 'delivery-1',
      status: 'PENDING',
      replayed: true,
    });
  });

  it('enqueues nothing when another replay already claimed the delivery', async () => {
    const { deliveryService, service } = build({ claim: 0 });

    await expect(service.replayDeadLetterDelivery('org-1', 'delivery-1')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
    expect(deliveryService.queueDelivery).not.toHaveBeenCalled();
  });

  it('refuses to replay a delivery that is not dead-lettered', async () => {
    const { repository, deliveryService, service } = build({
      status: WebhookDeliveryStatus.DELIVERED,
    });

    await expect(service.replayDeadLetterDelivery('org-1', 'delivery-1')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
    expect(repository.claimDeadLetterForReplay).not.toHaveBeenCalled();
    expect(deliveryService.queueDelivery).not.toHaveBeenCalled();
  });

  it('returns 404 for a delivery outside the caller organization', async () => {
    const { repository, service } = build();
    repository.findDeliveryById.mockResolvedValue(null);

    await expect(service.replayDeadLetterDelivery('org-1', 'delivery-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('restores the dead-letter state when enqueueing fails', async () => {
    const { repository, deliveryService, service } = build();
    deliveryService.queueDelivery.mockRejectedValue(new Error('redis down'));

    await expect(service.replayDeadLetterDelivery('org-1', 'delivery-1')).rejects.toThrow(
      'redis down',
    );
    expect(repository.restoreDeadLetter).toHaveBeenCalledWith('org-1', 'delivery-1');
  });

  it('passes the status filter through to the delivery page query', async () => {
    const { repository, service } = build();

    await service.listDeliveries('org-1', {
      limit: 20,
      status: WebhookDeliveryStatus.DEAD_LETTER,
    });

    expect(repository.findDeliveryPage).toHaveBeenCalledWith(
      'org-1',
      undefined,
      21,
      WebhookDeliveryStatus.DEAD_LETTER,
    );
  });
});
