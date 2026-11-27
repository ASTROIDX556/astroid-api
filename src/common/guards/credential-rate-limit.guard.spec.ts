import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Redis } from 'ioredis';

import { CredentialRateLimitGuard } from './credential-rate-limit.guard';
import { CredentialQuotaCache, credentialQuotaCacheKey } from '../throttler/credential-quota';
import { SKIP_CREDENTIAL_RATE_LIMIT_KEY } from '../decorators/skip-credential-rate-limit.decorator';
import { CREDENTIAL_RATE_LIMIT_SCRIPT } from '../throttler/scripts/credential-rate-limit.lua';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';
import { RateLimitConfig } from '../../config/rate-limit.config';
import { HealthController } from '../../modules/health/health.controller';
import { MetricsController } from '../../modules/metrics/metrics.controller';

type EvalArgs = [script: string, numKeys: number, ...args: Array<string | number>];

const RATE_LIMIT: RateLimitConfig = {
  windowSeconds: 60,
  maxRequests: 120,
  public: {
    enabled: true,
    maxRequests: 60,
    windowSeconds: 60,
    trustProxy: false,
    clientIdentifiers: ['ip'],
  },
  credential: {
    perMinute: 120,
    minuteWindowSeconds: 60,
    perDay: 10_000,
    dayWindowSeconds: 86_400,
    quotaCacheSeconds: 60,
  },
  sensitive: {} as RateLimitConfig['sensitive'],
};

const ALLOWED = [1, 120, 119, 60_000, 0, 1, 1];
const MINUTE_EXHAUSTED = [0, 120, 0, 60_000, 30_000, 120, 120];
const DAY_EXHAUSTED = [0, 10_000, 0, 86_400_000, 3_600_000, 5, 10_000];

function makeRedis(evalResult: unknown = ALLOWED, evalError?: Error) {
  const eval_ = vi.fn();
  if (evalError) {
    eval_.mockRejectedValue(evalError);
  } else {
    eval_.mockResolvedValue(evalResult);
  }
  return {
    status: 'ready',
    eval: eval_,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };
}

function buildContext(request: Record<string, unknown>, response: { setHeader: ReturnType<typeof vi.fn> }) {
  const handler = () => undefined;
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class WalletController {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function prepare(
  opts: {
    request?: Record<string, unknown>;
    redis?: ReturnType<typeof makeRedis>;
    exempt?: boolean;
    type?: string;
    config?: RateLimitConfig;
  } = {},
) {
  const redis = opts.redis ?? makeRedis();
  const reflector = {
    getAllAndOverride: vi.fn((key: string) =>
      key === SKIP_CREDENTIAL_RATE_LIMIT_KEY ? opts.exempt : undefined,
    ),
  };
  const config = { getOrThrow: () => opts.config ?? RATE_LIMIT } as unknown as ConfigService;
  const quotaCache = new CredentialQuotaCache(config, redis as unknown as Redis);
  const guard = new CredentialRateLimitGuard(
    reflector as never,
    config,
    redis as unknown as Redis,
    quotaCache,
  );
  const response = { setHeader: vi.fn() };
  const request = opts.request ?? {
    ip: '203.0.113.7',
    headers: {},
    apiKey: { id: 'key-1' },
  };
  const context = buildContext(request, response);
  if (opts.type) {
    (context as unknown as { getType: () => string }).getType = () => opts.type as string;
  }
  return { guard, redis, response, context, quotaCache };
}

function headers(response: { setHeader: ReturnType<typeof vi.fn> }): Record<string, unknown> {
  return Object.fromEntries(response.setHeader.mock.calls);
}

describe('CredentialRateLimitGuard', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('identity', () => {
    it('keys the counter by the verified API key id', async () => {
      const { guard, redis, context } = prepare({
        request: { ip: '203.0.113.7', headers: {}, apiKey: { id: 'key-1' } },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);

      const [, numKeys, minuteKey, dayKey] = redis.eval.mock.calls[0] as EvalArgs;
      expect(numKeys).toBe(2);
      expect(minuteKey).toBe('astroid:rate-limit:credential:apikey:key-1:minute');
      expect(dayKey).toBe('astroid:rate-limit:credential:apikey:key-1:day');
    });

    it('bypasses JWT-authenticated requests instead of throttling dashboard traffic', async () => {
      const { guard, redis, context } = prepare({
        request: { ip: '203.0.113.7', headers: {}, user: { id: 'user-1', sub: 'user-1' } },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('falls back to the client IP for anonymous public routes', async () => {
      const { guard, redis, context } = prepare({
        request: { ip: '203.0.113.7', headers: {} },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });

    it('uses the API key id carried by an API-key JWT principal', async () => {
      const { guard, redis, context } = prepare({
        request: {
          ip: '203.0.113.7',
          headers: {},
          user: { id: 'key-9', apiKeyId: 'key-9', isApiKey: true },
        },
      });

      await guard.canActivate(context);

      expect((redis.eval.mock.calls[0] as EvalArgs)[2]).toContain('apikey:key-9');
    });
  });

  describe('quota resolution', () => {
    it('applies the configured defaults when the key has no override', async () => {
      const { guard, redis, context } = prepare({
        request: { ip: '1.2.3.4', headers: {}, apiKey: { id: 'key-1' } },
      });

      await guard.canActivate(context);

      const [, , , , perMinute, minuteWindow, perDay, dayWindow] = redis.eval.mock.calls[0] as EvalArgs;
      expect([perMinute, minuteWindow, perDay, dayWindow]).toEqual([120, 60_000, 10_000, 86_400_000]);
    });

    it('uses the configured minute window', async () => {
      const { guard, redis, context } = prepare({
        config: {
          ...RATE_LIMIT,
          credential: { ...RATE_LIMIT.credential, minuteWindowSeconds: 30 },
        },
      });

      await guard.canActivate(context);

      expect((redis.eval.mock.calls[0] as EvalArgs)[5]).toBe(30_000);
    });

    it('honours per-key minute and day overrides and caches them briefly', async () => {
      const { guard, redis, context } = prepare({
        request: {
          ip: '1.2.3.4',
          headers: {},
          apiKey: { id: 'key-1', rateLimitPerMinute: 600, rateLimitPerDay: 500_000 },
        },
      });

      await guard.canActivate(context);

      const [, , , , perMinute, , perDay] = redis.eval.mock.calls[0] as EvalArgs;
      expect([perMinute, perDay]).toEqual([600, 500_000]);
      expect(redis.set).toHaveBeenCalledWith(
        credentialQuotaCacheKey('key-1'),
        JSON.stringify({ perMinute: 600, perDay: 500_000 }),
        'EX',
        60,
      );
    });

    it('reads a cached override when the request carries only a credential id', async () => {
      const redis = makeRedis();
      redis.get.mockResolvedValue(JSON.stringify({ perMinute: 300, perDay: 20_000 }));
      const { guard, context } = prepare({
        redis,
        request: { ip: '1.2.3.4', headers: {}, user: { id: 'key-2', apiKeyId: 'key-2', isApiKey: true } },
      });

      await guard.canActivate(context);

      const [, , , , perMinute, , perDay] = redis.eval.mock.calls[0] as EvalArgs;
      expect([perMinute, perDay]).toEqual([300, 20_000]);
    });

    it('ignores malformed overrides and keeps the defaults', async () => {
      const { guard, redis, context } = prepare({
        request: {
          ip: '1.2.3.4',
          headers: {},
          apiKey: { id: 'key-1', rateLimitPerMinute: -5, rateLimitPerDay: 1.5 },
        },
      });

      await guard.canActivate(context);

      const [, , , , perMinute, , perDay] = redis.eval.mock.calls[0] as EvalArgs;
      expect([perMinute, perDay]).toEqual([120, 10_000]);
    });
  });

  describe('response headers', () => {
    it('reports the binding window on a successful response', async () => {
      const { guard, response, context } = prepare();

      await guard.canActivate(context);

      expect(headers(response)).toEqual({
        'X-RateLimit-Limit': 120,
        'X-RateLimit-Remaining': 119,
        'X-RateLimit-Reset': 60,
        'RateLimit-Limit': 120,
        'RateLimit-Remaining': 119,
        'RateLimit-Reset': 60,
      });
    });

    it('answers 429 with Retry-After and the standard error code when the minute window is spent', async () => {
      const redis = makeRedis(MINUTE_EXHAUSTED);
      const { guard, response, context } = prepare({ redis });

      const error = await guard.canActivate(context).catch((e: DomainException) => e);
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe(ErrorCode.RATE_LIMITED);
      expect((error as DomainException).getStatus()).toBe(429);
      expect(headers(response)).toMatchObject({
        'X-RateLimit-Limit': 120,
        'X-RateLimit-Remaining': 0,
        'Retry-After': 30,
      });
    });

    it('reports the day window when it is the one exhausted', async () => {
      const redis = makeRedis(DAY_EXHAUSTED);
      const { guard, response, context } = prepare({ redis });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(DomainException);
      expect(headers(response)).toMatchObject({
        'X-RateLimit-Limit': 10_000,
        'X-RateLimit-Remaining': 0,
        'X-RateLimit-Reset': 86_400,
        'Retry-After': 3_600,
      });
    });

    it('never reports a Retry-After below one second', async () => {
      const redis = makeRedis([0, 120, 0, 60_000, 10, 120, 120]);
      const { guard, response, context } = prepare({ redis });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(DomainException);
      expect(headers(response)['Retry-After']).toBe(1);
    });
  });

  describe('exemptions and failure policy', () => {
    it('skips routes marked with @SkipCredentialRateLimit()', async () => {
      const { guard, redis, context } = prepare({ exempt: true });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('ignores non-HTTP contexts', async () => {
      const { guard, redis, context } = prepare({ type: 'ws' });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it.each([
      ['liveness', HealthController, HealthController.prototype.live],
      ['readiness', HealthController, HealthController.prototype.ready],
      ['metrics', MetricsController, MetricsController.prototype.scrape],
    ])('exempts the real %s route metadata', async (_name, controller, handler) => {
      const redis = makeRedis();
      const config = { getOrThrow: () => RATE_LIMIT } as unknown as ConfigService;
      const guard = new CredentialRateLimitGuard(
        new Reflector(),
        config,
        redis as unknown as Redis,
        new CredentialQuotaCache(config, redis as unknown as Redis),
      );
      const context = {
        getType: () => 'http',
        getHandler: () => handler,
        getClass: () => controller,
        switchToHttp: () => ({
          getRequest: () => ({ ip: '203.0.113.7', headers: {} }),
          getResponse: () => ({ setHeader: vi.fn() }),
        }),
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('fails open with a warning when Redis is unreachable', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:15.000Z'));
      const redis = makeRedis(undefined, new Error('connect ECONNREFUSED 127.0.0.1:6379'));
      const { guard, response, context } = prepare({ redis });

      try {
        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(headers(response)).toEqual({
          'X-RateLimit-Limit': 120,
          'X-RateLimit-Remaining': 120,
          'X-RateLimit-Reset': Math.ceil(new Date('2026-01-01T00:01:15.000Z').getTime() / 1000),
        });
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
          expect.stringContaining('allowing request (fails open)'),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails open when the Redis client is not ready', async () => {
      const redis = makeRedis();
      redis.status = 'end';
      const { guard, context } = prepare({ redis });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(redis.eval).not.toHaveBeenCalled();
    });
  });

  describe('script contract', () => {
    it('runs the dedicated atomic script with both windows', async () => {
      const { guard, redis, context } = prepare();

      await guard.canActivate(context);

      const [script] = redis.eval.mock.calls[0] as EvalArgs;
      expect(script).toBe(CREDENTIAL_RATE_LIMIT_SCRIPT);
      expect(script).toContain("redis.call('TIME')");
      expect(script).toContain("redis.call('ZREMRANGEBYSCORE'");
      expect(script).toContain("redis.call('ZADD'");
    });
  });
});
