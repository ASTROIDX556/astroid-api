import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { buildWebhookJobId, WEBHOOK_JOB_NAME } from '../../../queues/webhook.queue';
import { DeadLetterWebhookRecord } from './webhook-dlq.service';
import { WebhookDlqDispatcher } from './webhook-dlq.dispatcher';
import { WebhookJobData } from '../types/webhook-job.types';

describe('WebhookDlqDispatcher', () => {
  const add = vi.fn();
  const getJob = vi.fn();
  const findFirst = vi.fn();

  const record: DeadLetterWebhookRecord = {
    id: 'delivery-1',
    organizationId: 'org-1',
    webhookId: 'wh-1',
    eventId: 'evt-1',
    eventType: 'transaction.completed',
    payload: {},
    attemptsMade: 5,
    lastError: 'HTTP 503',
    statusCode: 503,
    failedAt: new Date('2026-01-15T10:00:00.000Z'),
  };

  const delivery = {
    id: 'delivery-1',
    organizationId: 'org-1',
    webhookId: 'wh-1',
    eventId: 'evt-1',
    eventName: 'transaction.completed',
    payload: { event: 'transaction.completed', data: { id: 'txn-1' } },
    status: 'FAILED',
    webhook: { id: 'wh-1', url: 'https://example.com/hook', enabled: true },
  };

  const dispatcher = () =>
    new WebhookDlqDispatcher(
      { webhookDelivery: { findFirst } } as never,
      { add, getJob } as unknown as Queue<WebhookJobData>,
    );

  beforeEach(() => {
    add.mockReset().mockResolvedValue({ id: 'replay-1' });
    getJob.mockReset().mockResolvedValue(undefined);
    findFirst.mockReset().mockResolvedValue(delivery);
  });

  it('re-enqueues the delivery on the webhooks queue with the retry policy', async () => {
    const result = await dispatcher().enqueueReplay(record);

    expect(result.jobId).toBe('webhook-replay-delivery-1');
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, options] = add.mock.calls[0] as [
      string,
      WebhookJobData,
      Record<string, unknown>,
    ];
    expect(name).toBe(WEBHOOK_JOB_NAME);
    expect(data).toMatchObject({
      webhookId: 'wh-1',
      organizationId: 'org-1',
      eventId: 'evt-1',
      eventName: 'transaction.completed',
      url: 'https://example.com/hook',
    });
    expect(options).toMatchObject({
      jobId: 'webhook-replay-delivery-1',
      attempts: expect.any(Number),
      backoff: expect.objectContaining({ type: 'custom' }),
    });
    expect((options.attempts as number)).toBeGreaterThan(1);
  });

  it('scopes the lookup to the caller organization', async () => {
    await dispatcher().enqueueReplay(record);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'delivery-1', organizationId: 'org-1' },
      }),
    );
  });

  it('refuses a delivery that is not dead-lettered', async () => {
    findFirst.mockResolvedValueOnce({ ...delivery, status: 'DELIVERED' });

    await expect(dispatcher().enqueueReplay(record)).rejects.toThrow(ConflictException);
    expect(add).not.toHaveBeenCalled();
  });

  it('refuses a replay while the same event and subscription are in flight', async () => {
    getJob.mockImplementation(async (id: string) =>
      id === buildWebhookJobId('evt-1', 'wh-1')
        ? { id, getState: vi.fn().mockResolvedValue('active') }
        : undefined,
    );

    await expect(dispatcher().enqueueReplay(record)).rejects.toThrow(/already active/);
    expect(add).not.toHaveBeenCalled();
  });

  it('refuses a replay while the same delivery is already being replayed', async () => {
    getJob.mockImplementation(async (id: string) =>
      id === 'webhook-replay-delivery-1'
        ? { id, getState: vi.fn().mockResolvedValue('waiting') }
        : undefined,
    );

    await expect(dispatcher().enqueueReplay(record)).rejects.toThrow(/already being replayed/);
    expect(add).not.toHaveBeenCalled();
  });

  it('replays again once the previous delivery and replay are no longer in flight', async () => {
    getJob.mockImplementation(async (id: string) => ({
      id,
      getState: vi.fn().mockResolvedValue('failed'),
    }));

    await expect(dispatcher().enqueueReplay(record)).resolves.toEqual({
      jobId: 'webhook-replay-delivery-1',
    });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException for a foreign or unknown delivery', async () => {
    findFirst.mockResolvedValueOnce(null);

    await expect(dispatcher().enqueueReplay(record)).rejects.toThrow(NotFoundException);
  });
});
