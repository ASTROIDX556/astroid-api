import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Job, UnrecoverableError } from 'bullmq';
import { WebhookDeliveryStatus } from '@prisma/client';
import { WebhookWorker } from './webhook.worker';
import { WebhookRetryPolicy } from '../webhook-retry.policy';
import { WebhookJobData } from '../types/webhook-job.types';
import { PrismaService } from '../../../database/prisma.service';

const settings = {
  maxAttempts: 3,
  timeoutMs: 1_000,
  jitterRatio: 0,
  delaysMs: [30_000, 60_000, 300_000] as const,
};

const jobData: WebhookJobData = {
  webhookId: 'wh_1',
  organizationId: 'org_1',
  url: 'https://consumer.test/hook',
  secret: 'whsec_test',
  eventName: 'transaction.completed',
  payload: { event: 'transaction.completed', data: { transactionId: 'tx_1' } },
  eventId: 'transaction-tx_1-1700000000000',
};

function createJob(attemptsMade = 0): Job<WebhookJobData> {
  return { id: 'job_1', data: jobData, attemptsMade } as unknown as Job<WebhookJobData>;
}

describe('WebhookWorker', () => {
  let upsert: ReturnType<typeof vi.fn>;
  let deadLetterAdd: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let worker: WebhookWorker;

  beforeEach(() => {
    upsert = vi.fn().mockResolvedValue({});
    deadLetterAdd = vi.fn().mockResolvedValue({});
    const prisma = { webhookDelivery: { upsert } } as unknown as PrismaService;
    const queue = { add: deadLetterAdd } as never;
    worker = new WebhookWorker(prisma, queue, new WebhookRetryPolicy(settings));

    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const respond = (status: number, body = '') =>
    fetchSpy.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: `Status ${status}`,
      text: () => Promise.resolve(body),
    });

  const persistedStatuses = () =>
    upsert.mock.calls.map((call) => {
      const args = call[0] as { create: { status: WebhookDeliveryStatus } };
      return args.create.status;
    });

  const lastUpsert = () =>
    upsert.mock.calls[upsert.mock.calls.length - 1]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };

  it('signs the request exactly as consumers expect and does not change header names', async () => {
    respond(200, 'OK');
    const result = await worker.process(createJob());

    expect(result).toEqual({ success: true, statusCode: 200 });
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(jobData.url);
    expect(options.method).toBe('POST');
    expect(Object.keys(options.headers)).toEqual(
      expect.arrayContaining([
        'content-type',
        'x-astroid-signature',
        'x-astroid-event-id',
        'x-astroid-event',
        'user-agent',
      ]),
    );
    expect(options.headers['x-astroid-event']).toBe('transaction.completed');
    expect(options.headers['x-astroid-event-id']).toBe(jobData.eventId);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('records a single successful delivery', async () => {
    respond(201);
    await worker.process(createJob());

    expect(upsert).toHaveBeenCalledOnce();
    expect(persistedStatuses()).toEqual([WebhookDeliveryStatus.DELIVERED]);
    expect(lastUpsert().create).toMatchObject({
      attempts: 1,
      lastStatusCode: 201,
      nextAttemptAt: null,
      deadLetteredAt: null,
    });
    expect(deadLetterAdd).not.toHaveBeenCalled();
  });

  it('retries a 5xx with the configured backoff and records the next attempt', async () => {
    respond(503, 'unavailable');

    await expect(worker.process(createJob(0))).rejects.toThrow('HTTP 503');
    expect(persistedStatuses()).toEqual([WebhookDeliveryStatus.RETRYING]);
    expect(lastUpsert().create).toMatchObject({
      attempts: 1,
      lastStatusCode: 503,
    });
    expect(lastUpsert().create.nextAttemptAt).toBeInstanceOf(Date);
    expect(lastUpsert().create.lastError).toContain('HTTP 503');
    expect(deadLetterAdd).not.toHaveBeenCalled();
  });

  it('retries on network errors and timeouts', async () => {
    fetchSpy.mockRejectedValue(new Error('The operation was aborted'));

    await expect(worker.process(createJob(0))).rejects.toThrow('aborted');
    expect(persistedStatuses()).toEqual([WebhookDeliveryStatus.RETRYING]);
    expect(lastUpsert().create.lastStatusCode).toBeNull();
  });

  it('treats 429 as retryable', async () => {
    respond(429, 'slow down');
    await expect(worker.process(createJob(0))).rejects.toThrow('HTTP 429');
    expect(persistedStatuses()).toEqual([WebhookDeliveryStatus.RETRYING]);
  });

  it('fails a 400 immediately without further attempts and dead-letters it', async () => {
    respond(400, 'bad payload');

    await expect(worker.process(createJob(0))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(persistedStatuses()).toEqual([WebhookDeliveryStatus.FAILED_PERMANENTLY]);
    expect(lastUpsert().create.deadLetteredAt).toBeInstanceOf(Date);
    expect(deadLetterAdd).toHaveBeenCalledOnce();
    expect(deadLetterAdd.mock.calls[0][1]).toMatchObject({ webhookId: 'wh_1' });
  });

  it('moves the delivery to the DLQ after the final allowed attempt', async () => {
    respond(500, 'boom');

    // maxAttempts = 3, attemptsMade = 2 -> this is the third (last) attempt.
    await expect(worker.process(createJob(2))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(persistedStatuses()).toEqual([WebhookDeliveryStatus.FAILED_PERMANENTLY]);
    expect(lastUpsert().create).toMatchObject({ attempts: 3, lastStatusCode: 500 });
    expect(deadLetterAdd).toHaveBeenCalledOnce();
  });

  it('keeps retrying while attempts remain', async () => {
    respond(500, 'boom');

    await expect(worker.process(createJob(1))).rejects.toThrow('HTTP 500');
    expect(persistedStatuses()).toEqual([WebhookDeliveryStatus.RETRYING]);
    expect(deadLetterAdd).not.toHaveBeenCalled();
  });

  it('never lets a persistence failure break delivery retries', async () => {
    upsert.mockRejectedValue(new Error('db down'));
    respond(500, 'boom');

    await expect(worker.process(createJob(0))).rejects.toThrow('HTTP 500');
    expect(deadLetterAdd).not.toHaveBeenCalled();
  });

  it('still succeeds when persistence fails after a successful delivery', async () => {
    upsert.mockRejectedValue(new Error('db down'));
    respond(200);

    await expect(worker.process(createJob())).resolves.toEqual({
      success: true,
      statusCode: 200,
    });
  });
});
