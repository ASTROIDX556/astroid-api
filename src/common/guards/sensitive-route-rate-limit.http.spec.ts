import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller, INestApplication, Logger, Post } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SensitiveRateLimit } from '../decorators/sensitive-rate-limit.decorator';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { REDIS_CLIENT } from '../locks/locks.constants';
import { MemorySlidingWindowStore } from '../throttler/sliding-window.store';

@Controller('auth')
class FakeAuthController {
  @Post('login')
  @SensitiveRateLimit('login')
  login() {
    return { ok: true };
  }
}

@Controller('webhooks')
class FakeWebhookController {
  @Post()
  @SensitiveRateLimit('webhookCreate')
  create() {
    return { ok: true };
  }
}

const LOGIN_LIMIT = 3;

/**
 * Requests past a configured limit over real HTTP: the guard, the global problem
 * details filter and a Redis double running the sliding-window semantics.
 */
describe('Sensitive-route rate limiting over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  let store: MemorySlidingWindowStore;
  const redis = {
    status: 'ready',
    eval: vi.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FakeAuthController, FakeWebhookController],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: REDIS_CLIENT, useValue: redis },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => ({
              public: { trustProxy: false },
              sensitive: {
                login: { maxRequests: LOGIN_LIMIT, windowSeconds: 60 },
                refresh: { maxRequests: 30, windowSeconds: 60 },
                apiKeyCreate: { maxRequests: 10, windowSeconds: 3600 },
                webhookCreate: { maxRequests: 20, windowSeconds: 3600 },
                webhookRotateSecret: { maxRequests: 10, windowSeconds: 3600 },
              },
            }),
          },
        },
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
    store = new MemorySlidingWindowStore();
    redis.status = 'ready';
    redis.eval.mockReset().mockImplementation(
      async (_s: string, _n: number, key: string, now: number, windowMs: number, limit: number) => {
        const hit = await store.hit(key, limit, windowMs, now);
        return [hit.allowed ? 1 : 0, hit.count, hit.resetAt];
      },
    );
  });

  const login = () => fetch(`${baseUrl}/auth/login`, { method: 'POST' });

  it('answers 429 with Retry-After and a problem-details body once the limit is passed', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      statuses.push((await login()).status);
    }
    const blocked = await login();

    expect(statuses).toEqual([201, 201, 201]);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(blocked.headers.get('x-ratelimit-limit')).toBe(String(LOGIN_LIMIT));
    expect(blocked.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(blocked.headers.get('content-type')).toContain('application/problem+json');
    expect(await blocked.json()).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      title: 'Too Many Requests',
      instance: '/auth/login',
      details: { limit: LOGIN_LIMIT, windowSeconds: 60 },
    });
  });

  it('fails closed on login with 503 RATE_LIMIT_UNAVAILABLE while Redis is down', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    redis.status = 'reconnecting';

    const res = await login();

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 503,
      code: 'RATE_LIMIT_UNAVAILABLE',
      title: 'Rate Limiter Unavailable',
    });
  });

  it('fails open on webhook creation while Redis is down', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    redis.status = 'reconnecting';

    const res = await fetch(`${baseUrl}/webhooks`, { method: 'POST' });

    expect(res.status).toBe(201);
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
