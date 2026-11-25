import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { BalanceCacheService, BALANCE_CACHE_KEY_PREFIX } from './balance-cache.service';
import { BalanceCacheConfig } from '../../../config/balance-cache.config';

const ADDRESS = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';
const BALANCES = [
  { asset: 'XLM', balance: '100.0000000', assetType: 'native' },
  { asset: 'USDC', balance: '50.0000000', assetType: 'credit_alphanum4' },
];

function buildConfig(settings: Partial<BalanceCacheConfig> = {}): ConfigService {
  const value: BalanceCacheConfig = { ttlSeconds: 30, environment: 'test', ...settings };
  return {
    get: vi.fn((key: string) => (key === 'balanceCache' ? value : undefined)),
  } as unknown as ConfigService;
}

/** Minimal ioredis stand-in: only the commands the cache issues. */
class FakeRedis {
  readonly store = new Map<string, string>();
  failGet: Error | null = null;
  failSet: Error | null = null;
  failDel: Error | null = null;

  get = vi.fn(async (key: string) => {
    if (this.failGet) throw this.failGet;
    return this.store.get(key) ?? null;
  });

  setex = vi.fn(async (key: string, _ttl: number, value: string) => {
    if (this.failSet) throw this.failSet;
    this.store.set(key, value);
    return 'OK';
  });

  del = vi.fn(async (key: string) => {
    if (this.failDel) throw this.failDel;
    return this.store.delete(key) ? 1 : 0;
  });
}

/** A promise whose resolution is driven by the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BalanceCacheService', () => {
  let redis: FakeRedis;
  let service: BalanceCacheService;

  beforeEach(() => {
    vi.restoreAllMocks();
    redis = new FakeRedis();
    service = new BalanceCacheService(buildConfig(), redis as unknown as Redis);
  });

  describe('key namespacing', () => {
    it('namespaces the key by environment, network and wallet address', () => {
      expect(service.cacheKey(ADDRESS, 'testnet')).toBe(
        `${BALANCE_CACHE_KEY_PREFIX}:test:testnet:${ADDRESS}`,
      );
      expect(service.getEnvironment()).toBe('test');
      expect(service.cacheKey(ADDRESS, 'public')).not.toBe(service.cacheKey(ADDRESS, 'testnet'));
    });

    it('uses the configured TTL', () => {
      expect(service.getTtlSeconds()).toBe(30);
      expect(new BalanceCacheService(buildConfig({ ttlSeconds: 5 }), redis as unknown as Redis).getTtlSeconds()).toBe(5);
    });
  });

  describe('get / set', () => {
    it('stores an entry with the configured TTL and reads it back', async () => {
      await service.set(ADDRESS, 'testnet', BALANCES);

      expect(redis.setex).toHaveBeenCalledWith(
        service.cacheKey(ADDRESS, 'testnet'),
        30,
        expect.any(String),
      );
      const cached = await service.get(ADDRESS, 'testnet');
      expect(cached?.balances).toEqual(BALANCES);
      expect(cached?.cachedAt).toEqual(expect.any(Number));
    });

    it('returns null on a cache miss', async () => {
      await expect(service.get(ADDRESS, 'testnet')).resolves.toBeNull();
    });

    it('ignores an entry older than the TTL even if Redis still holds it', async () => {
      const entry = {
        address: ADDRESS,
        network: 'testnet',
        balances: BALANCES,
        cachedAt: Date.now() - 60_000,
      };
      redis.store.set(service.cacheKey(ADDRESS, 'testnet'), JSON.stringify(entry));

      await expect(service.get(ADDRESS, 'testnet')).resolves.toBeNull();
    });

    it('discards a malformed entry instead of failing the read', async () => {
      redis.store.set(service.cacheKey(ADDRESS, 'testnet'), '{"oops":true}');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(service.get(ADDRESS, 'testnet')).resolves.toBeNull();
    });
  });

  describe('getOrLoad', () => {
    it('serves two reads inside the TTL from one RPC call', async () => {
      const loader = vi.fn().mockResolvedValue(BALANCES);

      const first = await service.getOrLoad(ADDRESS, 'testnet', loader);
      const second = await service.getOrLoad(ADDRESS, 'testnet', loader);

      expect(first).toEqual(BALANCES);
      expect(second).toEqual(BALANCES);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(redis.setex).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent misses for the same wallet', async () => {
      const pending = deferred<typeof BALANCES>();
      const loader = vi.fn(() => pending.promise);

      const first = service.getOrLoad(ADDRESS, 'testnet', loader);
      const second = service.getOrLoad(ADDRESS, 'testnet', loader);
      pending.resolve(BALANCES);

      await expect(Promise.all([first, second])).resolves.toEqual([BALANCES, BALANCES]);
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('keeps the two networks of one address apart', async () => {
      const loader = vi.fn().mockResolvedValue(BALANCES);

      await service.getOrLoad(ADDRESS, 'testnet', loader);
      await service.getOrLoad(ADDRESS, 'public', loader);

      expect(loader).toHaveBeenCalledTimes(2);
      expect(redis.store.has(service.cacheKey(ADDRESS, 'testnet'))).toBe(true);
      expect(redis.store.has(service.cacheKey(ADDRESS, 'public'))).toBe(true);
    });
  });

  describe('invalidate', () => {
    it('deletes the key so the next read hits the RPC again', async () => {
      const loader = vi.fn().mockResolvedValue(BALANCES);

      await service.getOrLoad(ADDRESS, 'testnet', loader);
      await service.invalidate(ADDRESS, 'testnet');
      await service.getOrLoad(ADDRESS, 'testnet', loader);

      expect(redis.del).toHaveBeenCalledWith(service.cacheKey(ADDRESS, 'testnet'));
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('does not let a load started before the invalidation repopulate the key', async () => {
      const pending = deferred<typeof BALANCES>();
      const loader = vi.fn(() => pending.promise);

      const read = service.getOrLoad(ADDRESS, 'testnet', loader);
      // Let the cache miss and the loader start before deleting the key.
      await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
      await service.invalidate(ADDRESS, 'testnet');
      pending.resolve(BALANCES);
      await read;

      expect(redis.setex).not.toHaveBeenCalled();
      await expect(service.get(ADDRESS, 'testnet')).resolves.toBeNull();
    });
  });

  describe('Redis failure', () => {
    it('falls through to the RPC when the read fails', async () => {
      const loggerWarn = vi.spyOn(
        (await import('@nestjs/common')).Logger.prototype,
        'warn',
      ).mockImplementation(() => undefined);
      redis.failGet = new Error('connection refused');
      const loader = vi.fn().mockResolvedValue(BALANCES);

      await expect(service.getOrLoad(ADDRESS, 'testnet', loader)).resolves.toEqual(BALANCES);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('Redis get failed'),
      );
    });

    it('still returns the RPC result when the write fails', async () => {
      const loggerWarn = vi.spyOn(
        (await import('@nestjs/common')).Logger.prototype,
        'warn',
      ).mockImplementation(() => undefined);
      redis.failSet = new Error('OOM');

      const loader = vi.fn().mockResolvedValue(BALANCES);
      await expect(service.getOrLoad(ADDRESS, 'testnet', loader)).resolves.toEqual(BALANCES);

      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('Redis setex failed'));
    });

    it('swallows an invalidation failure so the write that triggered it succeeds', async () => {
      const loggerWarn = vi.spyOn(
        (await import('@nestjs/common')).Logger.prototype,
        'warn',
      ).mockImplementation(() => undefined);
      redis.failDel = new Error('connection reset');

      await expect(service.invalidate(ADDRESS, 'testnet')).resolves.toBeUndefined();
      expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('Redis del failed'));
    });
  });

  describe('without a Redis client', () => {
    it('never fails a read: every call goes to the RPC', async () => {
      const offline = new BalanceCacheService(buildConfig());
      const loader = vi.fn().mockResolvedValue(BALANCES);

      await expect(offline.getOrLoad(ADDRESS, 'testnet', loader)).resolves.toEqual(BALANCES);
      await expect(offline.getOrLoad(ADDRESS, 'testnet', loader)).resolves.toEqual(BALANCES);

      expect(loader).toHaveBeenCalledTimes(2);
      await expect(offline.get(ADDRESS, 'testnet')).resolves.toBeNull();
      await expect(offline.set(ADDRESS, 'testnet', BALANCES)).resolves.toBeUndefined();
      await expect(offline.invalidate(ADDRESS, 'testnet')).resolves.toBeUndefined();
    });
  });

  describe('checkThresholds', () => {
    it('detects a low XLM balance', () => {
      const alerts = service.checkThresholds([
        { asset: 'XLM', balance: '5.0000000', assetType: 'native' },
        { asset: 'USDC', balance: '1000.0000000', assetType: 'credit_alphanum4' },
      ]);

      expect(alerts).toEqual([{ asset: 'XLM', balance: '5.0000000', threshold: 10 }]);
    });

    it('does not alert for healthy balances', () => {
      expect(service.checkThresholds(BALANCES)).toEqual([]);
    });
  });
});
