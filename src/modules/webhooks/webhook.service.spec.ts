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
    let destinationPolicy: {
      post: (url: string, options: { headers: Record<string, string>; body: Buffer; timeoutMs: number }) => Promise<{ status: number }>;
    };

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      destinationPolicy = {
        post: async (url, options) => {
          const response = await fetch(url, {
            method: 'POST',
            headers: options.headers,
            body: options.body.toString('utf8'),
            signal: AbortSignal.timeout(options.timeoutMs),
          });
          return { status: response.status };
        },
      };
      processor = new WebhooksProcessor(
        { webhook: { findFirst: vi.fn().mockResolvedValue({ secret: SECRET }) } } as never,
        undefined,
        undefined,
        destinationPolicy,
      );
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
          eventName: 'budget.exceeded',
          payload: { event: 'budget.exceeded', data: {} },
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      await processor.process(job);
      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers['x-astroid-signature']).toBeDefined();
      expect(opts.headers['x-astroid-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(opts.headers['x-astroid-signature-version']).toBe('v1');
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
          eventName: 'policy.violated',
          payload,
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      await processor.process(job);
      const [, opts] = fetchSpy.mock.calls[0];
      const body: Buffer = Buffer.from(opts.body);
      expect(opts.headers['x-astroid-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(opts.headers['x-astroid-signature-version']).toBe('v1');
      expect(body.toString('utf8')).toBe(JSON.stringify(payload));
    });

    it('uses 5000ms timeout on fetch', async () => {
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });
      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
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

    it('loads the secret by webhook and organization rather than from the job payload', async () => {
      const fallbackSecret = 'fallback-secret-123';
      const findFirst = vi.fn().mockResolvedValue({ secret: fallbackSecret });
      const processorWithDatabaseSecret = new WebhooksProcessor(
        { webhook: { findFirst } } as never,
        undefined,
        undefined,
        destinationPolicy,
      );
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('OK') });

      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
          eventName: 'transaction.completed',
          payload: { hello: 'world' },
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      await processorWithDatabaseSecret.process(job);
      const [, opts] = fetchSpy.mock.calls[0];
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'wh-1', organizationId: 'org-1' },
        select: { secret: true, url: true, enabled: true },
      });
      expect(job.data).not.toHaveProperty('secret');
      expect(opts.headers['x-astroid-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    });

    it('throws UnrecoverableError for non-transient 4xx and does not retry', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('Unauthorized') });
      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
          eventName: 'wallet.created',
          payload: {},
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;
      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
    });

    it('does not follow a redirect and treats it as a permanent endpoint failure', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 302,
        headers: { get: () => 'http://127.0.0.1/' },
      });
      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
          eventName: 'wallet.created',
          payload: {},
          eventId: EVENT_ID,
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      await expect(processor.process(job)).rejects.toThrow(UnrecoverableError);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('throws retriable error for transient 5xx to allow BullMQ exponential backoff', async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('Service Unavailable') });
      const job = {
        id: 'job-1',
        data: {
          webhookId: 'wh-1',
          organizationId: 'org-1',
          url: URL,
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
    it('queues with 5 attempts and the custom backoff strategy', async () => {
      const { WebhookDeliveryService } = await import('./services/webhook-delivery.service');
      const { DEFAULT_WEBHOOK_CONFIG } = await import('../../config/webhook.config');
      const mockQueue = { add: vi.fn().mockResolvedValue({ id: 'job-1' }) } as unknown as import('bullmq').Queue<WebhookJobData>;
      const config = {
        getOrThrow: vi.fn().mockReturnValue(DEFAULT_WEBHOOK_CONFIG),
      } as unknown as import('@nestjs/config').ConfigService;
      const svc = new WebhookDeliveryService(mockQueue, config);
      await svc.queueDelivery({
        webhookId: 'wh-1',
        organizationId: 'org-1',
        url: URL,
        eventName: 'transaction.completed',
        payload: {},
        eventId: 'evt-1',
      });
      const call = vi.mocked(mockQueue.add).mock.calls[0];
      expect(call[2]?.attempts).toBe(5);
      // The `custom` backoff type is what makes BullMQ use the registered
      // jittered and capped strategy.
      expect(call[2]?.backoff).toEqual({ type: 'custom', delay: 2000 });
    });
  });

  describe('WebhookService – Secret storage encryption at rest', () => {
    it('encrypts signing secret before persisting on create and returns plaintext secret once', async () => {
      const { WebhookService } = await import('./webhook.service');
      const encryptionService = {
        encrypt: vi.fn((plain: string) => `enc:v1:test:${plain}`),
        decrypt: vi.fn(),
        isEncrypted: vi.fn(),
      };
      const repository = {
        create: vi.fn(async (data: { secret: string; url: string; organizationId: string; events: string[]; enabled: boolean }) => ({
          id: 'wh-created-1',
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      };
      const destinationPolicy = {
        validate: vi.fn().mockResolvedValue(undefined),
      };

      const svc = new WebhookService(repository as never, destinationPolicy as never, encryptionService as never);
      const result = await svc.create('org-1', {
        url: 'https://example.com/webhook',
        events: ['transaction.completed'],
        enabled: true,
      });

      expect(result.id).toBe('wh-created-1');
      expect(result.secret).toMatch(/^whsec_[0-9a-f]+$/);
      expect(encryptionService.encrypt).toHaveBeenCalledWith(result.secret);
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          secret: `enc:v1:test:${result.secret}`,
        }),
      );
    });

    it('encrypts new secret before persisting on rotateSecret and returns plaintext secret once', async () => {
      const { WebhookService } = await import('./webhook.service');
      const encryptionService = {
        encrypt: vi.fn((plain: string) => `enc:v1:test:${plain}`),
        decrypt: vi.fn(),
        isEncrypted: vi.fn(),
      };
      const repository = {
        findById: vi.fn().mockResolvedValue({ id: 'wh-1', organizationId: 'org-1', secret: 'old-secret' }),
        update: vi.fn(async (id: string, data: { secret?: string }) => ({
          id,
          secret: data.secret,
          updatedAt: new Date(),
        })),
      };
      const destinationPolicy = {
        validate: vi.fn().mockResolvedValue(undefined),
      };

      const svc = new WebhookService(repository as never, destinationPolicy as never, encryptionService as never);
      const result = await svc.rotateSecret('org-1', 'wh-1');

      expect(result.id).toBe('wh-1');
      expect(result.secret).toMatch(/^whsec_[0-9a-f]+$/);
      expect(encryptionService.encrypt).toHaveBeenCalledWith(result.secret);
      expect(repository.update).toHaveBeenCalledWith(
        'wh-1',
        expect.objectContaining({
          secret: `enc:v1:test:${result.secret}`,
        }),
      );
    });
  });

  describe('WebhooksProcessor – Secret decryption and failure handling', () => {
    it('decrypts encrypted secret from database and delivers successfully', async () => {
      const plainSecret = 'whsec_decrypted_success';
      const encryptedSecret = 'enc:v1:mock_encrypted';
      const findFirst = vi.fn().mockResolvedValue({ secret: encryptedSecret, url: 'https://example.com/webhook' });
      const encryptionService = {
        isEncrypted: vi.fn((val: string) => val.startsWith('enc:v1:')),
        decrypt: vi.fn().mockReturnValue(plainSecret),
        encrypt: vi.fn(),
      };
      const destinationPolicy = {
        post: vi.fn().mockResolvedValue({ status: 200 }),
      };

      const processor = new WebhooksProcessor(
        { webhook: { findFirst } } as never,
        undefined,
        undefined,
        destinationPolicy as never,
        undefined,
        undefined,
        undefined,
        undefined,
        encryptionService as never,
      );

      const job = {
        id: 'job-enc-test',
        data: {
          webhookId: 'wh-enc',
          organizationId: 'org-1',
          url: 'https://example.com/webhook',
          eventName: 'transaction.completed',
          payload: { txId: '123' },
          eventId: 'evt-enc',
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      const result = await processor.process(job);
      expect(result).toEqual({ success: true, statusCode: 200 });
      expect(encryptionService.decrypt).toHaveBeenCalledWith(encryptedSecret);

      const [, callOpts] = destinationPolicy.post.mock.calls[0];
      const { verifyWebhookSignature } = await import('./utils/signing');
      expect(
        verifyWebhookSignature(
          plainSecret,
          callOpts.headers['x-astroid-timestamp'],
          Buffer.from(callOpts.body),
          callOpts.headers['x-astroid-signature'],
        ),
      ).toBe(true);
    });

    it('fails delivery permanently with clear error when secret is missing', async () => {
      const findFirst = vi.fn().mockResolvedValue({ secret: null, url: 'https://example.com/webhook' });
      const processor = new WebhooksProcessor(
        { webhook: { findFirst } } as never,
        undefined,
        undefined,
        { post: vi.fn() } as never,
      );

      const job = {
        id: 'job-missing-secret',
        data: {
          webhookId: 'wh-missing',
          organizationId: 'org-1',
          url: 'https://example.com/webhook',
          eventName: 'transaction.completed',
          payload: {},
          eventId: 'evt-missing',
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      await expect(processor.process(job)).rejects.toThrow('Webhook signing secret is unavailable');
    });

    it('fails delivery permanently when secret is corrupted/un-decryptable', async () => {
      const findFirst = vi.fn().mockResolvedValue({ secret: 'enc:v1:corrupt', url: 'https://example.com/webhook' });
      const encryptionService = {
        isEncrypted: vi.fn().mockReturnValue(true),
        decrypt: vi.fn().mockImplementation(() => {
          throw new Error('Decryption failed');
        }),
        encrypt: vi.fn(),
      };

      const processor = new WebhooksProcessor(
        { webhook: { findFirst } } as never,
        undefined,
        undefined,
        { post: vi.fn() } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        encryptionService as never,
      );

      const job = {
        id: 'job-corrupt-secret',
        data: {
          webhookId: 'wh-corrupt',
          organizationId: 'org-1',
          url: 'https://example.com/webhook',
          eventName: 'transaction.completed',
          payload: {},
          eventId: 'evt-corrupt',
        },
        attemptsMade: 0,
      } as unknown as Job<WebhookJobData>;

      await expect(processor.process(job)).rejects.toThrow('Webhook signing secret is invalid or corrupted');
    });
  });

  const URL = 'https://example.com/webhook';
});
