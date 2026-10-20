import { describe, it, expect, vi } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import type { WebhookSecretResolver } from './webhook-signature.guard';
import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../constants/headers';
import { signWebhookPayload } from '../../modules/webhooks/utils/signing';

describe('WebhookSignatureGuard', () => {
  const secret = 'test-webhook-secret';
  const mockConfigService = {
    get: (key: string) => {
      if (key === 'WEBHOOK_SECRET') return secret;
      return null;
    },
  } as unknown as ConfigService;

  const guard = new WebhookSignatureGuard(mockConfigService);

  function createMockContext(headers: Record<string, string>, body: unknown): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          body,
          rawBody: typeof body === 'string' ? body : JSON.stringify(body),
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('should accept valid legacy signature and fresh timestamp', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = { event: 'soroban.contract.invoked', ledger: 12345 };
    const rawBody = JSON.stringify(body);

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${timestamp}.${rawBody}`);
    const signature = hmac.digest('hex');

    const context = createMockContext(
      {
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
      },
      body,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('accepts the versioned signature produced for outbound webhook deliveries', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const eventId = 'evt-123';
    const rawBody = Buffer.from('{"event":"transaction.completed"}');
    const signature = signWebhookPayload(secret, timestamp, eventId, rawBody);
    const context = createMockContext(
      {
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_EVENT_ID_HEADER]: eventId,
      },
      rawBody.toString('utf8'),
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects a tampered versioned webhook payload', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const eventId = 'evt-123';
    const signature = signWebhookPayload(secret, timestamp, eventId, Buffer.from('{"amount":1}'));
    const context = createMockContext(
      {
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_EVENT_ID_HEADER]: eventId,
      },
      '{"amount":2}',
    );

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject requests with expired timestamp (> 5 minutes)', async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 400; // ~6.6 minutes ago
    const body = { event: 'soroban.contract.invoked' };
    const rawBody = JSON.stringify(body);

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${timestamp}.${rawBody}`);
    const signature = hmac.digest('hex');

    const context = createMockContext(
      {
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
      },
      body,
    );

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject requests with modified body / invalid signature', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = { event: 'soroban.contract.invoked', amount: 100 };
    const tamperedBody = { event: 'soroban.contract.invoked', amount: 999 };

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${timestamp}.${JSON.stringify(body)}`);
    const signature = hmac.digest('hex');

    const context = createMockContext(
      {
        [WEBHOOK_SIGNATURE_HEADER]: signature,
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
      },
      tamperedBody,
    );

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject requests with missing signature header', async () => {
    const context = createMockContext(
      { [WEBHOOK_TIMESTAMP_HEADER]: Math.floor(Date.now() / 1000).toString() },
      { foo: 'bar' },
    );
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject requests with missing timestamp header', async () => {
    const context = createMockContext(
      { [WEBHOOK_SIGNATURE_HEADER]: 'abc123' },
      { foo: 'bar' },
    );
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject requests with non-numeric timestamp', async () => {
    const context = createMockContext(
      {
        [WEBHOOK_SIGNATURE_HEADER]: 'abc123',
        [WEBHOOK_TIMESTAMP_HEADER]: 'not-a-number',
      },
      { foo: 'bar' },
    );
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should reject when no secret is configured', async () => {
    const noSecretConfig = {
      get: () => null,
    } as unknown as ConfigService;
    const guardNoSecret = new WebhookSignatureGuard(noSecretConfig);

    const timestamp = Math.floor(Date.now() / 1000);
    const context = createMockContext(
      {
        [WEBHOOK_SIGNATURE_HEADER]: 'abc123',
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
      },
      { foo: 'bar' },
    );

    await expect(guardNoSecret.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  describe('per-integration secret resolver', () => {
    it('should use custom secret resolver when provided', async () => {
      const customSecret = 'integration-specific-secret';
      const secretResolver: WebhookSecretResolver = vi.fn().mockReturnValue(customSecret);

      const guardWithResolver = new WebhookSignatureGuard(mockConfigService, {
        secretResolver,
      });

      const timestamp = Math.floor(Date.now() / 1000);
      const body = { event: 'test' };
      const rawBody = JSON.stringify(body);

      const hmac = crypto.createHmac('sha256', customSecret);
      hmac.update(`${timestamp}.${rawBody}`);
      const signature = hmac.digest('hex');

      const context = createMockContext(
        {
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
          'x-integration-id': 'integration-123',
        },
        body,
      );

      await expect(guardWithResolver.canActivate(context)).resolves.toBe(true);
      expect(secretResolver).toHaveBeenCalledWith(
        expect.objectContaining({ headers: expect.any(Object) }),
        'integration-123',
      );
    });

    it('should fall back to global secret when resolver returns undefined', async () => {
      const secretResolver: WebhookSecretResolver = vi.fn().mockReturnValue(undefined);

      const guardWithResolver = new WebhookSignatureGuard(mockConfigService, {
        secretResolver,
      });

      const timestamp = Math.floor(Date.now() / 1000);
      const body = { event: 'test' };
      const rawBody = JSON.stringify(body);

      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(`${timestamp}.${rawBody}`);
      const signature = hmac.digest('hex');

      const context = createMockContext(
        {
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
        },
        body,
      );

      await expect(guardWithResolver.canActivate(context)).resolves.toBe(true);
    });

    it('resolves asynchronous integration secrets', async () => {
      const customSecret = 'integration-specific-secret';
      const secretResolver: WebhookSecretResolver = vi.fn().mockResolvedValue(customSecret);
      const guardWithResolver = new WebhookSignatureGuard(mockConfigService, { secretResolver });
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({ event: 'test' });
      const hmac = crypto.createHmac('sha256', customSecret).update(`${timestamp}.${rawBody}`);
      const context = createMockContext(
        {
          [WEBHOOK_SIGNATURE_HEADER]: hmac.digest('hex'),
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
        },
        rawBody,
      );

      await expect(guardWithResolver.canActivate(context)).resolves.toBe(true);
    });

    it('should reject with custom secret when signature does not match', async () => {
      const customSecret = 'integration-specific-secret';
      const secretResolver: WebhookSecretResolver = vi.fn().mockReturnValue(customSecret);

      const guardWithResolver = new WebhookSignatureGuard(mockConfigService, {
        secretResolver,
      });

      const timestamp = Math.floor(Date.now() / 1000);
      const body = { event: 'test' };
      const rawBody = JSON.stringify(body);

      // Sign with the WRONG secret
      const hmac = crypto.createHmac('sha256', 'wrong-secret');
      hmac.update(`${timestamp}.${rawBody}`);
      const signature = hmac.digest('hex');

      const context = createMockContext(
        {
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
        },
        body,
      );

      await expect(guardWithResolver.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('custom tolerance', () => {
    it('should respect custom tolerance window', async () => {
      const guardShortTolerance = new WebhookSignatureGuard(mockConfigService, {
        toleranceSeconds: 60, // 1 minute
      });

      const timestamp = Math.floor(Date.now() / 1000) - 90; // 90 seconds ago
      const body = { event: 'test' };
      const rawBody = JSON.stringify(body);

      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(`${timestamp}.${rawBody}`);
      const signature = hmac.digest('hex');

      const context = createMockContext(
        {
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
        },
        body,
      );

      await expect(guardShortTolerance.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('raw body extraction', () => {
    it('should prefer rawBody over parsed body for HMAC computation', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = '{"event":"test","data":{"a":1}}';

      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(`${timestamp}.${rawBody}`);
      const signature = hmac.digest('hex');

      const request = {
        headers: {
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
        },
        body: { event: 'test', data: { a: 1 } }, // parsed body (may have different key order)
        rawBody: Buffer.from(rawBody),
      };

      const context = {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should fall back to JSON.stringify when rawBody is not set', async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const body = { event: 'test' };
      const rawBody = JSON.stringify(body);

      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(`${timestamp}.${rawBody}`);
      const signature = hmac.digest('hex');

      const request = {
        headers: {
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp.toString(),
        },
        body,
      };

      const context = {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });
});
