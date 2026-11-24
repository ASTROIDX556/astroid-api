import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { AstroidThrottlerGuard } from './throttler.guard';
import { createThrottlerOptions } from '../../config/throttler.config';
import { PublicRateLimitGuard } from './public-rate-limit.guard';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

const raw = 'ast_live_do_not_store_me';

describe('API key rate limiting', () => {
  it('uses the verified key ID rather than the raw header', async () => {
    const guard = new AstroidThrottlerGuard(
      createThrottlerOptions({
        windowSeconds: 60, apiLimit: 1, authLimit: 1, agentLimit: 1,
        webhookLimit: 1, apiBurst: 0, authBurst: 0, webhookBurst: 0,
      }),
      { increment: vi.fn() } as never,
      { getAllAndOverride: vi.fn() } as never,
    );
    const tracker = await guard['getTracker']({
      headers: { 'x-api-key': raw },
      apiKey: { id: 'key-123' },
    });
    expect(tracker).toBe('apikey:key-123');
    expect(tracker).not.toContain(raw);
  });

  it('hashes unverified API keys instead of writing secrets into Redis keys', async () => {
    const guard = new AstroidThrottlerGuard(
      createThrottlerOptions({
        windowSeconds: 60, apiLimit: 1, authLimit: 1, agentLimit: 1,
        webhookLimit: 1, apiBurst: 0, authBurst: 0, webhookBurst: 0,
      }),
      { increment: vi.fn() } as never,
      { getAllAndOverride: vi.fn() } as never,
    );
    const tracker = await guard['getTracker']({ headers: { 'x-api-key': raw } });
    expect(tracker).toBe(`apikey-sha256:${createHash('sha256').update(raw).digest('hex')}`);
    expect(tracker).not.toContain(raw);
  });

  it('enforces the public API-key bucket and returns 429 with Retry-After', async () => {
    const config = {
      getOrThrow: vi.fn(() => ({
        public: {
          enabled: true, maxRequests: 2, windowSeconds: 60,
          trustProxy: false, clientIdentifiers: ['apiKey'],
        },
      })),
      get: vi.fn(() => ({ apiPrefix: 'api/v1' })),
    } as unknown as ConfigService;
    const guard = new PublicRateLimitGuard(new Reflector(), config, { status: 'end' } as unknown as Redis);
    const responseHeaders: Record<string, unknown> = {};
    const handler = () => undefined;
    Reflect.defineMetadata('astroid:isPublic', true, handler);
    const context = {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => class PublicController {},
      switchToHttp: () => ({
        getRequest: () => ({
          path: '/api/v1/public/status', ip: '203.0.113.50',
          headers: { 'x-api-key': raw },
        }),
        getResponse: () => ({
          setHeader: (name: string, value: unknown) => { responseHeaders[name] = value; },
        }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(responseHeaders['Retry-After']).toBeGreaterThan(0);
    expect(responseHeaders['X-RateLimit-Remaining']).toBe(0);
  });
});
