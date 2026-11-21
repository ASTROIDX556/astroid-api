import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { SensitiveRateLimitGuard } from './sensitive-rate-limit.guard';
import { MemorySlidingWindowStore } from '../throttler/sliding-window.store';
import {
  SENSITIVE_RATE_LIMIT_KEY,
  SENSITIVE_ROUTE_POLICY,
  SensitiveRoute,
} from '../throttler/sensitive-route-policy';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { AuthController } from '../../modules/auth/auth.controller';
import { ApiKeyController } from '../../modules/developer/api-key.controller';
import { WebhookController } from '../../modules/webhooks/webhook.controller';
import { HealthController } from '../../modules/health/health.controller';

const LIMITS: Record<SensitiveRoute, { maxRequests: number; windowSeconds: number }> = {
  login: { maxRequests: 2, windowSeconds: 60 },
  refresh: { maxRequests: 3, windowSeconds: 60 },
  apiKeyCreate: { maxRequests: 2, windowSeconds: 3600 },
  webhookCreate: { maxRequests: 2, windowSeconds: 3600 },
  webhookRotateSecret: { maxRequests: 2, windowSeconds: 3600 },
};

/**
 * A Redis double whose `eval` runs the sliding-window script's semantics on the
 * in-memory store, so the guard is exercised end to end without a server.
 */
function fakeRedis() {
  const store = new MemorySlidingWindowStore();
  const keys: string[] = [];
  const redis = {
    status: 'ready',
    eval: vi.fn(
      async (_script: string, _n: number, key: string, now: number, windowMs: number, limit: number) => {
        keys.push(key);
        const hit = await store.hit(key, limit, windowMs, now);
        return [hit.allowed ? 1 : 0, hit.count, hit.resetAt];
      },
    ),
  };
  return { redis, keys };
}

interface FakeRequest {
  ip: string;
  headers: Record<string, string>;
  user?: Partial<AuthenticatedUser>;
}

function context(route: SensitiveRoute | undefined, request: FakeRequest) {
  const headers: Record<string, unknown> = {};
  const response = { setHeader: vi.fn((name: string, value: unknown) => (headers[name] = value)) };
  const handler = () => undefined;
  if (route) Reflect.defineMetadata(SENSITIVE_RATE_LIMIT_KEY, route, handler);
  const ctx = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class Fixture {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
  return { ctx, headers };
}

async function rejection(promise: Promise<unknown>): Promise<DomainException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainException) return error;
    throw error;
  }
  throw new Error('expected the guard to reject');
}

describe('SensitiveRateLimitGuard', () => {
  let redis: ReturnType<typeof fakeRedis>['redis'];
  let keys: string[];
  let guard: SensitiveRateLimitGuard;
  const anonymous = (): FakeRequest => ({ ip: '203.0.113.7', headers: {} });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
    ({ redis, keys } = fakeRedis());
    const config = {
      getOrThrow: () => ({ sensitive: LIMITS, public: { trustProxy: false } }),
    } as unknown as ConfigService;
    guard = new SensitiveRateLimitGuard(new Reflector(), config, redis as unknown as Redis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lets a route without @SensitiveRateLimit through without touching Redis', async () => {
    await expect(guard.canActivate(context(undefined, anonymous()).ctx)).resolves.toBe(true);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('allows requests within the limit and reports the remaining budget', async () => {
    const first = context('login', anonymous());
    await expect(guard.canActivate(first.ctx)).resolves.toBe(true);
    expect(first.headers).toMatchObject({ 'X-RateLimit-Limit': 2, 'X-RateLimit-Remaining': 1 });

    const second = context('login', anonymous());
    await expect(guard.canActivate(second.ctx)).resolves.toBe(true);
    expect(second.headers).toMatchObject({ 'X-RateLimit-Remaining': 0 });
  });

  it('blocks the request past the limit with 429, Retry-After and the limit details', async () => {
    await guard.canActivate(context('login', anonymous()).ctx);
    vi.advanceTimersByTime(10_000);
    await guard.canActivate(context('login', anonymous()).ctx);

    const third = context('login', anonymous());
    const error = await rejection(guard.canActivate(third.ctx));

    expect(error.code).toBe(ErrorCode.RATE_LIMITED);
    expect(error.getStatus()).toBe(429);
    expect(error.details).toEqual({ limit: 2, windowSeconds: 60, retryAfterSeconds: 50 });
    // The oldest request leaves the 60 s window 50 s from now.
    expect(third.headers['Retry-After']).toBe(50);
  });

  it('accepts requests again once the window has moved past the oldest one', async () => {
    await guard.canActivate(context('login', anonymous()).ctx);
    await guard.canActivate(context('login', anonymous()).ctx);
    await expect(guard.canActivate(context('login', anonymous()).ctx)).rejects.toThrow();

    vi.advanceTimersByTime(60_001);

    await expect(guard.canActivate(context('login', anonymous()).ctx)).resolves.toBe(true);
  });

  it('keeps a separate budget per route', async () => {
    await guard.canActivate(context('login', anonymous()).ctx);
    await guard.canActivate(context('login', anonymous()).ctx);

    await expect(guard.canActivate(context('refresh', anonymous()).ctx)).resolves.toBe(true);
    expect(new Set(keys)).toEqual(
      new Set([
        'rate-limit:sensitive:login:ip:203.0.113.7',
        'rate-limit:sensitive:refresh:ip:203.0.113.7',
      ]),
    );
  });

  it('counts pre-login routes per client IP', async () => {
    await guard.canActivate(context('login', anonymous()).ctx);
    await guard.canActivate(context('login', anonymous()).ctx);

    await expect(
      guard.canActivate(context('login', { ip: '198.51.100.9', headers: {} }).ctx),
    ).resolves.toBe(true);
  });

  it('counts authenticated routes per API key or user, not per shared IP', async () => {
    const apiKey = { ...anonymous(), user: { id: 'key-row', apiKeyId: 'ak_1', isApiKey: true } };
    const user = { ...anonymous(), user: { id: 'u_1', sub: 'u_1' } };

    await guard.canActivate(context('apiKeyCreate', apiKey).ctx);
    await guard.canActivate(context('apiKeyCreate', apiKey).ctx);
    await expect(guard.canActivate(context('apiKeyCreate', apiKey).ctx)).rejects.toThrow();
    await expect(guard.canActivate(context('apiKeyCreate', user).ctx)).resolves.toBe(true);

    expect(new Set(keys)).toEqual(
      new Set([
        'rate-limit:sensitive:apiKeyCreate:apikey:ak_1',
        'rate-limit:sensitive:apiKeyCreate:user:u_1',
      ]),
    );
  });

  describe('when Redis is unavailable', () => {
    it.each(['login', 'refresh', 'apiKeyCreate'] as const)(
      'fails closed on the credential route %s with 503 RATE_LIMIT_UNAVAILABLE',
      async (route) => {
        redis.status = 'reconnecting';
        const error = await rejection(
          guard.canActivate(context(route, { ...anonymous(), user: { id: 'u_1' } }).ctx),
        );

        expect(error.code).toBe(ErrorCode.RATE_LIMIT_UNAVAILABLE);
        expect(error.getStatus()).toBe(503);
        expect(redis.eval).not.toHaveBeenCalled();
      },
    );

    it.each(['webhookCreate', 'webhookRotateSecret'] as const)(
      'fails open on the management route %s with a warning',
      async (route) => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        redis.status = 'end';

        await expect(
          guard.canActivate(context(route, { ...anonymous(), user: { id: 'u_1' } }).ctx),
        ).resolves.toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`allowing "${route}"`));
      },
    );

    it('applies the same policy when the Redis command itself fails', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      redis.eval.mockRejectedValue(new Error('Connection is closed.'));

      const error = await rejection(guard.canActivate(context('login', anonymous()).ctx));
      expect(error.code).toBe(ErrorCode.RATE_LIMIT_UNAVAILABLE);

      await expect(
        guard.canActivate(context('webhookCreate', { ...anonymous(), user: { id: 'u_1' } }).ctx),
      ).resolves.toBe(true);
    });
  });

  it('pins the failure policy: credential routes fail closed, management routes fail open', () => {
    expect(SENSITIVE_ROUTE_POLICY).toEqual({
      login: { failureMode: 'closed', identity: 'ip' },
      refresh: { failureMode: 'closed', identity: 'ip' },
      apiKeyCreate: { failureMode: 'closed', identity: 'principal' },
      webhookCreate: { failureMode: 'open', identity: 'principal' },
      webhookRotateSecret: { failureMode: 'open', identity: 'principal' },
    });
  });
});

describe('@SensitiveRateLimit on the sensitive routes', () => {
  const routeOf = (handler: unknown) =>
    Reflect.getMetadata(SENSITIVE_RATE_LIMIT_KEY, handler as object) as SensitiveRoute | undefined;

  it('covers login, refresh, API-key creation, webhook creation and secret rotation', () => {
    expect(routeOf(AuthController.prototype.login)).toBe('login');
    expect(routeOf(AuthController.prototype.refresh)).toBe('refresh');
    expect(routeOf(ApiKeyController.prototype.create)).toBe('apiKeyCreate');
    expect(routeOf(WebhookController.prototype.create)).toBe('webhookCreate');
    expect(routeOf(WebhookController.prototype.rotate)).toBe('webhookRotateSecret');
  });

  it('leaves the health and readiness probes alone', () => {
    for (const name of Object.getOwnPropertyNames(HealthController.prototype)) {
      expect(routeOf((HealthController.prototype as unknown as Record<string, unknown>)[name])).toBeUndefined();
    }
  });
});
