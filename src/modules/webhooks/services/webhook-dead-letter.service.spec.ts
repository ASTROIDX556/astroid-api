import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, Queue } from 'bullmq';

import { Queues } from '../../../queues/queues.constants';
import { buildDeadLetterJobId } from '../../../queues/dlq';
import { WebhookDeadLetterService } from './webhook-dead-letter.service';
import { WebhookJobData } from '../types/webhook-job.types';

describe('WebhookDeadLetterService', () => {
  const add = vi.fn();
  const findMany = vi.fn();
  let prisma: Record<string, unknown>;

  const job = {
    id: 'job-1',
    name: 'webhook-delivery',
    attemptsMade: 4,
    data: {
      webhookId: 'wh-1',
      organizationId: 'org-1',
      url: 'https://example.com/hook',
      eventName: 'transaction.completed',
      eventId: 'evt-1',
      payload: { secret: 'should-not-be-copied' },
    },
  } as unknown as Job<WebhookJobData>;

  beforeEach(() => {
    add.mockReset().mockResolvedValue({ id: 'dlq-1' });
    findMany.mockReset().mockResolvedValue([
      {
        attemptNumber: 1,
        status: 'FAILED',
        responseStatus: 503,
        errorCode: 'HTTP_503',
        errorMessage: 'HTTP 503',
        durationMs: 42,
        createdAt: new Date('2026-01-15T10:00:00.000Z'),
      },
    ]);
    prisma = { webhookDeliveryAttempt: { findMany } };
  });

  const service = () =>
    new WebhookDeadLetterService(prisma as never, { add } as unknown as Queue);

  it('routes an exhausted delivery to the dead-letter queue with attempt history', async () => {
    await service().recordTerminalFailure(job, {
      failedReason: 'HTTP 503',
      attemptsMade: 5,
      responseStatus: 503,
      failureCategory: 'transient',
      failureCode: 'HTTP_503',
    });

    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, options] = add.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(name).toBe(`dlq:${Queues.Webhooks}:job-1`);
    expect(options).toMatchObject({
      jobId: buildDeadLetterJobId(Queues.Webhooks, 'job-1'),
    });
    expect(data).toMatchObject({
      originalQueue: Queues.Webhooks,
      originalJobId: 'job-1',
      originalJobName: 'webhook-delivery',
      failedReason: 'HTTP 503',
      attemptsMade: 5,
      // Only identifiers are copied; the event payload never follows the job.
      payload: {
        webhookId: 'wh-1',
        organizationId: 'org-1',
        eventName: 'transaction.completed',
        eventId: 'evt-1',
      },
      metadata: {
        subscriptionId: 'wh-1',
        webhookId: 'wh-1',
        eventId: 'evt-1',
        responseStatus: 503,
        failureCategory: 'transient',
        failureCode: 'HTTP_503',
        attemptHistory: [
          {
            attemptNumber: 1,
            status: 'FAILED',
            responseStatus: 503,
            errorCode: 'HTTP_503',
            errorMessage: 'HTTP 503',
            durationMs: 42,
            createdAt: '2026-01-15T10:00:00.000Z',
          },
        ],
      },
    });
    expect(JSON.stringify(data)).not.toContain('should-not-be-copied');
  });

  it('keeps the entry even when the attempt history cannot be read', async () => {
    findMany.mockRejectedValueOnce(new Error('db down'));

    await service().recordTerminalFailure(job, {
      failedReason: 'HTTP 500',
      attemptsMade: 5,
    });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][1]).toMatchObject({
      metadata: expect.objectContaining({ attemptHistory: [] }),
    });
  });

  it('swallows a dead-letter write failure so it cannot mask the delivery error', async () => {
    add.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      service().recordTerminalFailure(job, { failedReason: 'HTTP 500', attemptsMade: 5 }),
    ).resolves.toBeUndefined();
  });

  it('does not throw when the dead-letter queue is unavailable', async () => {
    const withoutQueue = new WebhookDeadLetterService(prisma as never, undefined);

    await expect(
      withoutQueue.recordTerminalFailure(job, { failedReason: 'HTTP 500', attemptsMade: 5 }),
    ).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
  });
});
