import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller, Get, INestApplication, Logger } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { CredentialRateLimitGuard } from './credential-rate-limit.guard';
import { CredentialQuotaCache } from '../throttler/credential-quota';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { REDIS_CLIENT } from '../locks/locks.constants';
import { Public } from '../decorators/public.decorator';
import { SkipCredentialRateLimit } from '../decorators/skip-credential-rate-limit.decorator';
import { ApiKeyService } from '../../modules/developer/api-key.service';

const PER_MINUTE = 3;
const PER_DAY = 100;

const READ_KEY = 'ak_live_read_key_0000000000000000000000000000000';
const OVERRIDE_KEY = 'ak_live_override_key_000000000000000000000000000';
const DAILY_KEY = 'ak_live_daily_key_000000000000000000000000000000';
const REVOKED_KEY = 'ak_live_revoked_key_0000000000000000000000000000';

const apiKeyStore: Record<string, Record<string, unknown>> = {
  [READ_KEY]: {
    id: 'key-read',
    organizationId: 'org-1',
    name: 'read key',
    prefix: 'ak_live_read',
    permissions: ['transactions:read'],
    allowedIps: [],
    revokedAt: null,
    expiresAt: null,
  },
  [OVERRIDE_KEY]: {
    id: 'key-override',
    organizationId: 'org-1',
    name: 'override key',
    prefix: 'ak_live_over',
    permissions: ['transactions:read'],
    allowedIps: [],
    revokedAt: null,
    expiresAt: null,
    rateLimitPerMinute: 1,
  },
  [DAILY_KEY]: {
    id: 'key-daily',
    organizationId: 'org-1',
    name: 'daily key',
    prefix: 'ak_live_dail',
    permissions: ['transactions:read'],
    allowedIps: [],
    revokedAt: null,
    expiresAt: null,
    rateLimitPerDay: 2,
  },
  [REVOKED_KEY]: {
    id: 'key-revoked',
    organizationId: 'org-1',
    name: 'revoked key',
    prefix: 'ak_live_revo',
    permissions: ['transactions:read'],
    allowedIps: [],
    revokedAt: new Date(),
    expiresAt: null,
  },
};

@Controller('wallets')
class WalletsController {
  @Get()
  list() {
    return [{ id: 'wallet-1' }];
  }
}

@Controller('health')
@Public()
@SkipCredentialRateLimit()
class ProbeController {
  @Get('ready')
  ready() {
    return { status: 'ok' };
  }
}

@Controller('public')
@Public()
class PublicController {
  @Get('status')
  status() {
    return { status: 'ok' };
  }
}

/**
 * Per-credential quota over real HTTP: authentication guard, credential guard,
 * the problem-details filter and a Redis double running the same fixed-window
 * semantics as the Lua script.
 */
describe('Credential rate limiting over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  const counters = new Map<string, { hits: number; resetAt: number }>();
  const cache = new Map<string, string>();
  const redis = { status: 'ready', eval: vi.fn(), get: vi.fn(), set: vi.fn() };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [WalletsController, ProbeController, PublicController],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: REDIS_CLIENT, useValue: redis },
        CredentialQuotaCache,
        {
          provide: ApiKeyService,
          useValue: {
            verify: vi.fn(async (raw: string) => {
              const key = apiKeyStore[raw];
              return key && !key.revokedAt ? key : null;
            }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => ({
              public: { trustProxy: false },
              credential: {
                perMinute: PER_MINUTE,
                minuteWindowSeconds: 60,
                perDay: PER_DAY,
                dayWindowSeconds: 86_400,
                quotaCacheSeconds: 60,
              },
            }),
          },
        },
        { provide: APP_GUARD, useClass: ApiKeyAuthGuard },
        { provide: APP_GUARD, useClass: CredentialRateLimitGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    counters.clear();
    cache.clear();
    redis.status = 'ready';
    redis.eval.mockClear();
    redis.get.mockClear();
    redis.set.mockClear();
    redis.get.mockImplementation(async (key: string) => cache.get(key) ?? null);
    redis.set.mockImplementation(async (key: string, value: string) => {
      cache.set(key, value);
      return 'OK';
    });
    redis.eval.mockImplementation(
      async (
        _script: string,
        _numKeys: number,
        minutePrefix: string,
        dayPrefix: string,
        minuteLimit: number,
        minuteWindow: number,
        dayLimit: number,
        dayWindow: number,
      ) => {
        const now = Date.now();
        const read = (prefix: string, window: number) => {
          const start = Math.floor(now / window) * window;
          const key = `${prefix}:${start}`;
          const existing = counters.get(key);
          const counter =
            !existing || existing.resetAt <= now ? { hits: 0, resetAt: start + window } : existing;
          counters.set(key, counter);
          return counter;
        };
        const minute = read(minutePrefix, minuteWindow);
        const day = read(dayPrefix, dayWindow);
        const allowed = minute.hits < minuteLimit && day.hits < dayLimit;
        if (allowed) {
          minute.hits += 1;
          day.hits += 1;
        }
        const minuteRemaining = Math.max(0, minuteLimit - minute.hits);
        const dayRemaining = Math.max(0, dayLimit - day.hits);
        const binding =
          dayRemaining / dayLimit < minuteRemaining / minuteLimit
            ? { limit: dayLimit, remaining: dayRemaining, resetAt: day.resetAt }
            : { limit: minuteLimit, remaining: minuteRemaining, resetAt: minute.resetAt };
        const retryAfter = allowed
          ? 0
          : Math.max(
              minute.hits >= minuteLimit ? minute.resetAt - now : 0,
              day.hits >= dayLimit ? day.resetAt - now : 0,
            );
        return [
          allowed ? 1 : 0,
          binding.limit,
          binding.remaining,
          binding.resetAt,
          retryAfter,
          minute.hits,
          day.hits,
        ];
      },
    );
  });

  const wallets = (apiKey?: string) =>
    fetch(`${baseUrl}/wallets`, { headers: apiKey ? { 'x-api-key': apiKey } : {} });

  it('reports the remaining quota on every successful response', async () => {
    const first = await wallets(READ_KEY);
    const second = await wallets(READ_KEY);

    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe(String(PER_MINUTE));
    expect(first.headers.get('x-ratelimit-remaining')).toBe(String(PER_MINUTE - 1));
    expect(Number(first.headers.get('x-ratelimit-reset'))).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(second.headers.get('x-ratelimit-remaining')).toBe(String(PER_MINUTE - 2));
  });

  it('answers 429 with Retry-After and the standard problem-details body once the quota is spent', async () => {
    for (let i = 0; i < PER_MINUTE; i++) {
      expect((await wallets(READ_KEY)).status).toBe(200);
    }
    const blocked = await wallets(READ_KEY);

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(blocked.headers.get('content-type')).toContain('application/problem+json');
    expect(await blocked.json()).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      title: 'Too Many Requests',
      instance: '/wallets',
      details: { limit: PER_MINUTE },
    });
  });

  it('counts each credential separately', async () => {
    for (let i = 0; i < PER_MINUTE; i++) {
      await wallets(READ_KEY);
    }

    expect((await wallets(READ_KEY)).status).toBe(429);
    expect((await wallets(DAILY_KEY)).status).toBe(200);
  });

  it('honours a per-key requests-per-minute override', async () => {
    expect((await wallets(OVERRIDE_KEY)).status).toBe(200);
    const blocked = await wallets(OVERRIDE_KEY);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('x-ratelimit-limit')).toBe('1');
  });

  it('honours a per-key requests-per-day override and reports the day window', async () => {
    expect((await wallets(DAILY_KEY)).status).toBe(200);
    expect((await wallets(DAILY_KEY)).status).toBe(200);
    const blocked = await wallets(DAILY_KEY);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('x-ratelimit-limit')).toBe('2');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(60);
  });

  it('never answers a readiness probe with 429', async () => {
    for (let i = 0; i < PER_MINUTE + 2; i++) {
      const res = await fetch(`${baseUrl}/health/ready`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-limit')).toBeNull();
    }
  });

  it('falls back to the client IP for anonymous public routes', async () => {
    for (let i = 0; i < PER_MINUTE; i++) {
      expect((await fetch(`${baseUrl}/public/status`)).status).toBe(200);
    }

    expect((await fetch(`${baseUrl}/public/status`)).status).toBe(429);
  });

  it('rejects a revoked key before it can consume any quota', async () => {
    const res = await wallets(REVOKED_KEY);

    expect(res.status).toBe(401);
    expect([...counters.keys()].some((key) => key.includes('key-revoked'))).toBe(false);
  });

  it('fails open when Redis is unavailable', async () => {
    redis.status = 'reconnecting';

    for (let i = 0; i < PER_MINUTE + 2; i++) {
      const response = await wallets(READ_KEY);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-ratelimit-limit')).toBe(String(PER_MINUTE));
      expect(response.headers.get('x-ratelimit-remaining')).toBe(String(PER_MINUTE));
      expect(response.headers.get('x-ratelimit-reset')).not.toBeNull();
    }
  });
});
