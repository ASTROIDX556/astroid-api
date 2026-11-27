import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { createHmac } from 'crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhooksProcessor } from './webhooks.processor';
import type { WebhookJobData } from './types/webhook-job.types';
import { buildWebhookJobId, WEBHOOK_JOB_NAME, webhookJobOptions } from '../../queues/webhook.queue';
import { verifyWebhookSignature } from './utils/signing';
import { WebhookSignatureGuard } from '../../common/guards/webhook-signature.guard';
import { WebhookIngressController } from './webhook-ingress.controller';

const createDestinationPolicy = () => ({
  post: async (
    url: string,
    options: { headers: Record<string, string>; body: Buffer; timeoutMs: number },
  ) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const headers: Record<string, string | string[] | undefined> = {};
    const responseHeaders = response.headers ?? new Headers();
    for (const [key, value] of responseHeaders.entries()) {
      headers[key.toLowerCase()] = value;
    }
    return { status: response.status, headers };
  },
});

describe('webhook delivery integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('dispatches an event through BullMQ options and delivers the same signed payload', async () => {
    const secret = 'whsec_integration_test_secret';
    const endpoint = 'https://subscriber.example.test/webhook';
    const queueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
    const deliveryService = new WebhookDeliveryService({ add: queueAdd } as never);
    const dispatcher = new WebhookDispatcher(
      {
        findEnabledForEvent: vi.fn().mockResolvedValue([
          { id: 'wh-1', organizationId: 'org-1', url: endpoint, secret },
        ]),
      } as never,
      deliveryService,
    );
    const prisma = {
      webhook: {
        findFirst: vi.fn().mockResolvedValue({ secret, url: endpoint, enabled: true }),
      },
      webhookDelivery: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const processor = new WebhooksProcessor(prisma as never, undefined, undefined, createDestinationPolicy());
    const response = { ok: true, status: 202 };
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);

    await dispatcher.dispatch({
      eventId: 'evt-stable-1',
      name: 'transaction.completed',
      organizationId: 'org-1',
      aggregateType: 'Transaction',
      aggregateId: 'txn-1',
      requestId: 'req-1',
      correlationId: 'corr-1',
      payload: { transactionId: 'txn-1', amount: '25' },
      occurredAt: new Date('2026-10-19T20:00:00.000Z'),
    });

    const [name, data, options] = queueAdd.mock.calls[0] as [
      string,
      WebhookJobData,
      typeof webhookJobOptions,
    ];
    expect(name).toBe(WEBHOOK_JOB_NAME);
    expect(options).toEqual({
      ...webhookJobOptions,
      jobId: buildWebhookJobId(data.eventId, data.webhookId),
      group: expect.any(String),
    });
    expect(options.attempts).toBeGreaterThan(1);
    expect(options.backoff).toEqual(expect.objectContaining({ type: 'exponential' }));
    expect(data).not.toHaveProperty('secret');

    await processor.process({
      id: 'job-1',
      name,
      data,
      attemptsMade: 0,
      opts: options,
    } as Job<WebhookJobData>);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(request.method).toBe('POST');
    expect(Buffer.isBuffer(request.body)).toBe(true);
    expect(verifyWebhookSignature(
      secret,
      request.headers['x-astroid-timestamp'],
      request.body,
      request.headers['x-astroid-signature'],
    )).toBe(true);
    expect(JSON.parse(request.body.toString('utf8'))).toEqual({
      event: 'transaction.completed',
      occurredAt: '2026-10-19T20:00:00.000Z',
      aggregateType: 'Transaction',
      aggregateId: 'txn-1',
      data: { transactionId: 'txn-1', amount: '25' },
    });
  });

  it('retries a transient endpoint failure and keeps the event identity stable', async () => {
    const secret = 'whsec_retry_test_secret';
    const endpoint = 'https://subscriber.example.test/webhook';
    const queueAdd = vi.fn().mockResolvedValue({ id: 'job-retry' });
    const dispatcher = new WebhookDispatcher(
      { findEnabledForEvent: vi.fn().mockResolvedValue([{ id: 'wh-2', organizationId: 'org-1', url: endpoint }]) } as never,
      new WebhookDeliveryService({ add: queueAdd } as never),
    );
    const processor = new WebhooksProcessor(
      {
        webhook: {
          findFirst: vi.fn().mockResolvedValue({ secret, url: endpoint, enabled: true }),
        },
      } as never,
      undefined,
      undefined,
      createDestinationPolicy(),
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetch);

    await dispatcher.dispatch({
      eventId: 'evt-retry-stable',
      name: 'transaction.completed',
      organizationId: 'org-1',
      aggregateType: 'Transaction',
      aggregateId: 'txn-2',
      payload: { transactionId: 'txn-2' },
      occurredAt: new Date('2026-10-19T20:00:00.000Z'),
    });
    const [name, data, options] = queueAdd.mock.calls[0] as [
      string,
      WebhookJobData,
      typeof webhookJobOptions,
    ];
    const job = (attemptsMade: number) =>
      ({ id: 'job-retry', name, data, attemptsMade, opts: options }) as Job<WebhookJobData>;

    await expect(processor.process(job(0))).rejects.toThrow('HTTP 503');
    await expect(processor.process(job(1))).resolves.toMatchObject({ success: true, statusCode: 200 });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(data.eventId).toBe('evt-retry-stable');
    expect(fetch.mock.calls[0][1].body).toEqual(fetch.mock.calls[1][1].body);
    expect(fetch.mock.calls[0][1].headers['x-astroid-event-id']).toBe('evt-retry-stable');
    expect(fetch.mock.calls[1][1].headers['x-astroid-event-id']).toBe('evt-retry-stable');
  });

  it('retries a real endpoint that answers 500 and succeeds on the next attempt', async () => {
    const secret = 'whsec_real_server_retry_secret';
    const received: Array<{ body: Buffer; signature?: string; eventId?: string }> = [];

    // A real HTTP endpoint: 500 on the first delivery, 200 on the retry.
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          body: Buffer.concat(chunks),
          signature: request.headers['x-astroid-signature'] as string | undefined,
          eventId: request.headers['x-astroid-event-id'] as string | undefined,
        });
        response.writeHead(received.length === 1 ? 500 : 200);
        response.end(received.length === 1 ? 'boom' : 'ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/webhook`;

    try {
      const prisma = {
        webhook: {
          findFirst: vi.fn().mockResolvedValue({ secret, url: endpoint, enabled: true }),
        },
        webhookDelivery: { upsert: vi.fn().mockResolvedValue({}) },
      };
      const processor = new WebhooksProcessor(
        prisma as never,
        undefined,
        undefined,
        createDestinationPolicy(),
      );
      const data: WebhookJobData = {
        webhookId: 'wh-real',
        organizationId: 'org-1',
        url: endpoint,
        eventName: 'transaction.completed',
        payload: { transactionId: 'txn-real' },
        eventId: 'evt-real-retry',
      };
      const job = (attemptsMade: number) =>
        ({
          id: buildWebhookJobId(data.eventId, data.webhookId),
          name: WEBHOOK_JOB_NAME,
          data,
          attemptsMade,
          opts: webhookJobOptions,
        }) as Job<WebhookJobData>;

      await expect(processor.process(job(0))).rejects.toThrow('HTTP 500');
      expect(received).toHaveLength(1);

      await expect(processor.process(job(1))).resolves.toMatchObject({
        success: true,
        statusCode: 200,
      });

      expect(received).toHaveLength(2);
      // The retry delivers exactly the same signed event identity and bytes.
      expect(received[1].body.equals(received[0].body)).toBe(true);
      expect(received[1].eventId).toBe('evt-real-retry');
      expect(received[1].signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('builds the receiver signature from the exact serialized delivery bytes', () => {
    const secret = 'whsec_integration_test_secret';
    const timestamp = '1792430400';
    const rawBytes = Buffer.from('{ "amount": 25, "unit": "XLM" }');
    const signature = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBytes]))
      .digest('hex');

    expect(verifyWebhookSignature(secret, timestamp, rawBytes, `t=${timestamp},v1=${signature}`)).toBe(true);
    expect(
      verifyWebhookSignature(secret, timestamp, Buffer.from('{"amount":25,"unit":"XLM"}'), `t=${timestamp},v1=${signature}`),
    ).toBe(false);
  });

  it('allows only a correctly signed inbound callback to reach its handler', async () => {
    const secret = 'ingress_secret_for_integration_tests';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawBody = Buffer.from(
      JSON.stringify({ eventId: 'evt-inbound', eventType: 'partner.updated', data: { id: 'p-1' } }),
    );
    const signature = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
      .digest('hex');
    const ingressService = { handle: vi.fn().mockResolvedValue(undefined) };
    const controller = new WebhookIngressController(ingressService as never);
    const guard = new WebhookSignatureGuard(
      { get: () => secret } as never,
    );
    const makeContext = (receivedSignature: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {
              'x-astroid-signature': receivedSignature,
              'x-astroid-timestamp': timestamp,
            },
            rawBody,
            body: JSON.parse(rawBody.toString('utf8')),
          }),
        }),
      }) as never;

    await guard.canActivate(makeContext(signature));
    await controller.receive(JSON.parse(rawBody.toString('utf8')));
    expect(ingressService.handle).toHaveBeenCalledTimes(1);

    const invalidSignature = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;
    await expect(guard.canActivate(makeContext(invalidSignature))).rejects.toThrow();
    expect(ingressService.handle).toHaveBeenCalledTimes(1);
  });
});
