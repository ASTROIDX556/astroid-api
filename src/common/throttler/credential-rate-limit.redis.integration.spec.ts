import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';

import { RedisCredentialRateLimitStore } from './credential-rate-limit.store';

const redisUrl = process.env.REDIS_URL;
const MINUTE = 60_000;
const DAY = 86_400_000;

describe.skipIf(!redisUrl)('RedisCredentialRateLimitStore (real Redis)', () => {
  let redis: Redis;
  let store: RedisCredentialRateLimitStore;
  const created: string[] = [];

  const identity = (label: string) => {
    const value = `apikey:test-${label}-${randomUUID()}`;
    created.push(value);
    return value;
  };

  beforeAll(async () => {
    redis = new Redis(redisUrl as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    store = new RedisCredentialRateLimitStore(redis);
  });

  afterAll(async () => {
    if (!redis) return;
    const keys: string[] = [];
    for (const value of created) {
      keys.push(...(await redis.keys(`astroid:rate-limit:credential:${value}:*`)));
    }
    if (keys.length) {
      await redis.del(...keys);
    }
    await redis.quit();
  });

  it('lets exactly `limit` of many concurrent requests through', async () => {
    const credential = identity('concurrency');
    const quota = { perMinute: 10, perDay: 1_000 };

    const decisions = await Promise.all(
      Array.from({ length: 50 }, () => store.consume(credential, quota, { minuteWindowMs: MINUTE, dayWindowMs: DAY })),
    );

    expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
    expect(Math.max(...decisions.map((d) => d.minuteHits))).toBe(10);
    expect(Math.max(...decisions.map((d) => d.dayHits))).toBe(10);
  });

  it('does not consume quota for rejected requests', async () => {
    const credential = identity('rejected');
    const quota = { perMinute: 2, perDay: 1_000 };
    const windows = { minuteWindowMs: MINUTE, dayWindowMs: DAY };

    await store.consume(credential, quota, windows);
    await store.consume(credential, quota, windows);
    const third = await store.consume(credential, quota, windows);
    const fourth = await store.consume(credential, quota, windows);

    expect(third.allowed).toBe(false);
    expect(fourth.allowed).toBe(false);
    expect(fourth.minuteHits).toBe(2);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
    expect(fourth.retryAfterMs).toBeLessThanOrEqual(MINUTE);
  });

  it('keeps counting across a client restart (counters live in Redis)', async () => {
    const credential = identity('restart');
    const quota = { perMinute: 5, perDay: 1_000 };
    const windows = { minuteWindowMs: MINUTE, dayWindowMs: DAY };

    await store.consume(credential, quota, windows);
    await store.consume(credential, quota, windows);

    const restarted = new Redis(redisUrl as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await restarted.connect();
    try {
      const decision = await new RedisCredentialRateLimitStore(restarted).consume(
        credential,
        quota,
        windows,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.minuteHits).toBe(3);
      expect(decision.dayHits).toBe(3);
    } finally {
      await restarted.quit();
    }
  });

  it('enforces the day window independently of the minute window', async () => {
    const credential = identity('daily');
    const quota = { perMinute: 1_000, perDay: 3 };
    const windows = { minuteWindowMs: MINUTE, dayWindowMs: DAY };

    const decisions = await Promise.all(
      Array.from({ length: 5 }, () => store.consume(credential, quota, windows)),
    );

    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
    const blocked = decisions.find((d) => !d.allowed);
    expect(blocked?.limit).toBe(3);
    expect(blocked?.remaining).toBe(0);
    expect(blocked?.retryAfterMs).toBeGreaterThan(MINUTE);
  });

  it('keeps requests in the trailing window across an epoch boundary', async () => {
    const credential = identity('sliding');
    let now = 119_000;
    const clockedStore = new RedisCredentialRateLimitStore(redis, () => now);
    const quota = { perMinute: 1, perDay: 100 };
    const windows = { minuteWindowMs: MINUTE, dayWindowMs: DAY };

    expect((await clockedStore.consume(credential, quota, windows)).allowed).toBe(true);

    now = 120_000;
    const blocked = await clockedStore.consume(credential, quota, windows);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(59_000);

    now = 179_000;
    expect((await clockedStore.consume(credential, quota, windows)).allowed).toBe(true);
  });

  it('expires counters at the window end even for very long windows', async () => {
    const credential = identity('long-window');
    const thirtyDays = 30 * DAY;

    const decision = await store.consume(
      credential,
      { perMinute: 5, perDay: 100 },
      { minuteWindowMs: MINUTE, dayWindowMs: thirtyDays },
    );

    const dayKey = `astroid:rate-limit:credential:${credential}:day`;
    const ttl = await redis.pttl(dayKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(thirtyDays);
    expect(Math.abs(thirtyDays - ttl)).toBeLessThan(5_000);
    expect(decision.allowed).toBe(true);
  });
});
