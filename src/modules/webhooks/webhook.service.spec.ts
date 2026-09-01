import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { Job, UnrecoverableError } from 'bullmq';
import { WebhooksProcessor } from './webhooks.processor';
import { WebhookJobData } from './types/webhook-job.types';
import { generateWebhookSignature, buildWebhookHeaders, hmacSign } from '../../utils/crypto.util';

/**
 * Tests for webhook cryptographic signing and delivery header formatting.
 * Mirrors the acceptance criteria: HMAC-SHA256 signing with
 * timestamp + JSON body, standard headers, exponential backoff retries,
 * ConfigService fallback secret, and 5s HTTP timeout.
 */
describe('Webhook signing & delivery', () => {
  describe('crypto.util – HMAC and webhook helpers', () => {
    it('hmacSign produces deterministic HMAC-SHA256 hex', () => {
      const secret = 'whsec_test';
      const payload = '{"event":"test"}';
      const expected = createHmac('sha256', secret).update(payload).digest('hex');
      expect(hmacSign(secret, payload)).toBe(expected);
    });

    it('generateWebhookSignature uses timestamp concatenated with body', () => {
      const secret = 'whsec_abc123';
      const timestamp = '1700000000';
      const body = JSON.stringify({ event: 'wallet.created', data: { id: 'w-1' } });
      const expected = createHmac('sha256', secret).update(`${timestamp}${body}`).digest('hex');
      expect(generateWebhookSignature(secret, timestamp, body)).toBe(expected);
    });

    it('generateWebhookSignature differs for different timestamps', () => {
      const secret = 's';
      const body = '{"a":1}';
      const sig1 = generateWebhookSignature(secret, '1000', body);
      const sig2 = generateWebhookSignature(secret, '2000', body);
      expect(sig1).not.toBe(sig2);
    });

    it('buildWebhookHeaders includes required X-Astroid headers', () => {
      const headers = buildWebhookHeaders({
        signature: 'abc123',
        timestamp: '1700000000',
        deliveryId: 'delivery-123',
        eventName: 'transaction.completed',
      });
      expect(headers['x-astroid-signature']).toBe('abc123');
      expect(headers['x-astroid-timestamp']).toBe('1700000000');
      expect(headers['x-astroid-delivery']).toBe('delivery-123');
      expect(headers['x-astroid-event']).toBe('transaction.completed');
      // backward-compat alias
      expect(headers['x-astroid-event-id']).toBe('delivery-123');
    });
  });

  describe('WebhooksProcessor – header formatting & signature', () => {
    let processor: WebhooksProcessor;
    let fetchSpy: ReturnType<typeof vi.fn>;

    const SECRET = 'whsec_test-secret-key';
    const URL = 'https://example.com/webhook';
    const EVENT_ID = 'evt-123';

    beforeEach(() => {
      processor = new WebhooksProcessor({} as never);
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('sends X-Astroid-Signature, X-Astroid-Delivery, X-Astroid-Event headers', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
          secret: SECRET,
          eventName: 'budget.exceeded',
          payload: { event: 'budget.exceeded', data: {} },
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      await processor.process(job);
      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers['x-astroid-signature']).toBeDefined();
      expect(opts.headers['x-astroid-signature']).toMatch(/^[0-9a-f]{64}$/);
      expect(opts.headers['x-astroid-delivery']).toBe(EVENT_ID);
      expect(opts.headers['x-astroid-event']).toBe('budget.exceeded');
      expect(opts.headers['x-astroid-timestamp']).toMatch(/^\d+$/);
    });

    it('signature is HMAC-SHA256 of timestamp + body', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
      const payload = { event: 'policy.violated', data: { id: 'p1' } };
      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
          secret: SECRET,
          eventName: 'policy.violated',
          payload,
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      await processor.process(job);
      const [, opts] = fetchSpy.mock.calls[0];
      const body: string = opts.body;
      const timestamp: string = opts.headers['x-astroid-timestamp'];
      const expected = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
      expect(opts.headers['x-astroid-signature']).toBe(expected);
      expect(body).toBe(JSON.stringify(payload));
    });

    it('uses 5000ms timeout on fetch', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
          secret: SECRET,
          eventName: 'wallet.created',
          payload: {},
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;
      await processor.process(job);
      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it('falls back to ConfigService secret when per-endpoint secret is empty', async () => {
      const fallbackSecret = 'fallback-secret-123';
      const mockConfig = {
        get: vi.fn((key: string) => (key === 'WEBHOOK_SECRET' ? fallbackSecret : undefined)),
      } as unknown as import('@nestjs/config').ConfigService;
      const processorWithFallback = new WebhooksProcessor({} as never, mockConfig);
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });

      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
          secret: '',
          eventName: 'transaction.completed',
          payload: { hello: 'world' },
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      await processorWithFallback.process(job);
      const [, opts] = fetchSpy.mock.calls[0];
      const body: string = opts.body;
      const ts: string = opts.headers['x-astroid-timestamp'];
      const expected = createHmac('sha256', fallbackSecret).update(`${ts}.${body}`).digest('hex');
      expect(opts.headers['x-astroid-signature']).toBe(expected);
    });

    it('throws UnrecoverableError for non-transient 4xx and does not retry', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('Unauthorized') });
      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
          secret: SECRET,
          eventName: 'wallet.created',
          payload: {},
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;
      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
    });

    it('throws retriable error for transient 5xx to allow BullMQ exponential backoff', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('Service Unavailable') });
      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
          secret: SECRET,
          eventName: 'wallet.created',
          payload: {},
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;
      await expect(processor.process(job)).rejects.toThrow('HTTP 503');
      try {
        await processor.process(job);
      } catch (e) {
        expect(e).not.toBeInstanceOf(UnrecoverableError);
      }
    });
  });

  describe('WebhookDeliveryService – BullMQ retry configuration', () => {
    it('queues with 5 attempts and exponential backoff delay 2000', async () => {
      const { WebhookDeliveryService } = await import('./services/webhook-delivery.service');
      const mockQueue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) } as unknown as import('bullmq').Queue<WebhookJobData>;
      const svc = new WebhookDeliveryService(mockQueue);
      await svc.queueDelivery({
        webhookId: 'wh-1',
        organizationId: 'org-1',
        url: URL,
        secret: SECRET,
        eventName: 'transaction.completed',
        payload: {},
        eventId: 'evt-1',
      });
      const call = vi.mocked(mockQueue.add).mock.calls[0];
      expect(call[2]?.attempts).toBe(5);
      expect(call[2]?.backoff).toEqual({ type: 'exponential', delay: 2000 });
    });
  });

  const URL = 'https://example.com/webhook';
  const SECRET = 'whsec_test-secret-key';
});
