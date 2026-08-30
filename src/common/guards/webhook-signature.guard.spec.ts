import { describe, it, expect } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { WebhookSignatureGuard } from './webhook-signature.guard';
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

  it('should reject requests with missing headers', () => {
    const context = createMockContext({}, { foo: 'bar' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
