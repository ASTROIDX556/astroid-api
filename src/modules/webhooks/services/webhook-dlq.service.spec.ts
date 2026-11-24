import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  WebhookDlqService,
  DeadLetterWebhookRecord,
  WebhookDlqStore,
  WebhookReplayDispatcher,
} from './webhook-dlq.service';

describe('WebhookDlqService (#450)', () => {
  let store: WebhookDlqStore;
  let dispatcher: WebhookReplayDispatcher;
  let service: WebhookDlqService;

  const sampleRecord: DeadLetterWebhookRecord = {
    id: 'dlq_01',
    organizationId: 'org_01',
    webhookId: 'wh_01',
    eventType: 'transaction.completed',
    payload: { txId: 'tx_123' },
    attemptsMade: 5,
    lastError: 'HTTP 503 Service Unavailable',
    statusCode: 503,
    failedAt: new Date('2026-10-21T10:00:00Z'),
    replayedAt: null,
  };

  beforeEach(() => {
    store = {
      findManyByOrganization: vi.fn().mockResolvedValue({
        items: [sampleRecord],
        total: 1,
      }),
      findById: vi.fn().mockResolvedValue(sampleRecord),
      markReplayed: vi.fn().mockImplementation(async (_id: string, replayedAt: Date) => ({
        ...sampleRecord,
        replayedAt,
      })),
    };
    dispatcher = {
      enqueueReplay: vi.fn().mockResolvedValue({ jobId: 'job_replay_01' }),
    };
    service = new WebhookDlqService(store, dispatcher);
  });

  it('lists dead-letter webhook records with normalized pagination metadata', async () => {
    const result = await service.listFailedDeliveries('org_01', 1, 20);
    expect(result.items).toHaveLength(1);
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
  });

  it('enqueues a manual replay job and marks the DLQ record as replayed', async () => {
    const res = await service.replayDeadLetter('org_01', 'dlq_01');
    expect(res.jobId).toBe('job_replay_01');
    expect(res.record.replayedAt).toBeInstanceOf(Date);
    expect(dispatcher.enqueueReplay).toHaveBeenCalledWith(sampleRecord);
  });

  it('throws NotFoundException when replaying an unknown DLQ record', async () => {
    vi.mocked(store.findById).mockResolvedValueOnce(null);
    await expect(service.replayDeadLetter('org_01', 'dlq_missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});
