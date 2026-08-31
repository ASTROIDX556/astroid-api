import { describe, it, expect, vi } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import type { WebhookSecretResolver } from './webhook-signature.guard';
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../constants/headers';

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

  it('should accept valid signature and fresh timestamp', () => {
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

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should reject requests with expired timestamp (> 5 minutes)', () => {
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

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject requests with modified body / invalid signature', () => {
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

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject requests with missing signature header', () => {
    const context = createMockContext(
      { [WEBHOOK_TIMESTAMP_HEADER]: Math.floor(Date.now() / 1000).toString() },
      { foo: 'bar' },
    );
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject requests with missing timestamp header', () => {
    const context = createMockContext(
      { [WEBHOOK_SIGNATURE_HEADER]: 'abc123' },
      { foo: 'bar' },
    );
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject requests with non-numeric timestamp', () => {
    const context = createMockContext(
      {
        [WEBHOOK_SIGNATURE_HEADER]: 'abc123',
        [WEBHOOK_TIMESTAMP_HEADER]: 'not-a-number',
      },
      { foo: 'bar' },
    );
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject when no secret is configured', () => {
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

    expect(() => guardNoSecret.canActivate(context)).toThrow(UnauthorizedException);
  });

  describe('per-integration secret resolver', () => {
    it('should use custom secret resolver when provided', () => {
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

      expect(guardWithResolver.canActivate(context)).toBe(true);
      expect(secretResolver).toHaveBeenCalledWith(
        expect.objectContaining({ headers: expect.any(Object) }),
        'integration-123',
      );
    });

    it('should fall back to global secret when resolver returns undefined', () => {
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

      expect(guardWithResolver.canActivate(context)).toBe(true);
    });

    it('should reject with custom secret when signature does not match', () => {
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

      expect(() => guardWithResolver.canActivate(context)).toThrow(UnauthorizedException);
    });
  });

  describe('custom tolerance', () => {
    it('should respect custom tolerance window', () => {
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

      expect(() => guardShortTolerance.canActivate(context)).toThrow(UnauthorizedException);
    });
  });

  describe('raw body extraction', () => {
    it('should prefer rawBody over parsed body for HMAC computation', () => {
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

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should fall back to JSON.stringify when rawBody is not set', () => {
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

      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
