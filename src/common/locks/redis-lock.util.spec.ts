import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import { RedisLock, DEFAULT_LOCK_TTL_MS, LockAcquireOptions } from './redis-lock.util';
import { LockNotAcquiredException } from '../exceptions/domain.exception';

/**
 * In-memory Redis mock with faithful atomic mutual-exclusion semantics for the
 * lock primitives used by RedisLock:
 *   - `set(key, value, 'PX', ttl, 'NX')` only succeeds if the key is free
 *   - `eval(RELEASE_SCRIPT, 1, key, token)` deletes the key only when the
 *     stored token matches the caller's token (compare-and-delete)
 *
 * A single shared store plus real async scheduling lets concurrent contenders
 * observe real contention without an external Redis server.
 */
function createInMemoryRedis() {
  const store = new Map<string, { token: string }>();

  const set = vi.fn(
    async (key: string, value: string, mode: string, ttl: number, nx: string) => {
      if (nx === 'NX') {
        if (store.has(key)) return null;
        store.set(key, { token: value });
        if (mode === 'PX') {
          setTimeout(() => store.delete(key), ttl);
        }
        return 'OK';
      }
      store.set(key, { token: value });
      return 'OK';
    },
  );

  const evalMock = vi.fn(
    async (_script: string, _numKeys: number, key: string, token: string) => {
      const current = store.get(key);
      if (current && current.token === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  );

  const disconnect = vi.fn();

  return {
    redis: { set, eval: evalMock, disconnect } as unknown as Redis,
    store,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('RedisLock', () => {
  let redis: {
    set: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  let lock: RedisLock;

  beforeEach(() => {
    redis = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    };
    lock = new RedisLock(redis as unknown as Redis);
  });

  describe('acquire', () => {
    it('acquires a lock with SET NX and an expiry', async () => {
      const release = await lock.acquire('agent-1', 1000);

      expect(release).toEqual(expect.any(Function));
      expect(redis.set).toHaveBeenCalledWith(
        'lock:agent-1',
        expect.any(String),
        'PX',
        1000,
        'NX',
      );
    });

    it('prefixes the lock key with lock:', async () => {
      await lock.acquire('agent-1');
      expect(redis.set.mock.calls[0][0]).toBe('lock:agent-1');
    });

    it('uses a random token as the lock value', async () => {
      await lock.acquire('agent-1');
      expect(redis.set.mock.calls[0][1]).toEqual(expect.any(String));
    });

    it('throws LockNotAcquiredException when the lock is already held', async () => {
      redis.set.mockResolvedValue(null);

      await expect(lock.acquire('agent-1')).rejects.toBeInstanceOf(LockNotAcquiredException);
    });

    it('retries acquisition up to the requested number of attempts', async () => {
      redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');

      const release = await lock.acquire('agent-1', 5000, 2, 0);

      expect(release).toEqual(expect.any(Function));
      expect(redis.set).toHaveBeenCalledTimes(2);
    });

    it('gives up after exhausting all attempts', async () => {
      redis.set.mockResolvedValue(null);

      await expect(lock.acquire('agent-1', 5000, 3, 0)).rejects.toBeInstanceOf(
        LockNotAcquiredException,
      );
      expect(redis.set).toHaveBeenCalledTimes(3);
    });

    it('retries using the options form until the lock is released', async () => {
      const mock = createInMemoryRedis();
      const memLock = new RedisLock(mock.redis);

      const releaseA = await memLock.acquire('account:1', { retries: 0 });

      const contender = memLock.acquire('account:1', {
        retries: 50,
        baseDelayMs: 1,
        maxDelayMs: 5,
        jitterFactor: 0,
        timeoutMs: 10_000,
      } as LockAcquireOptions);

      setTimeout(() => releaseA(), 15);

      const releaseB = await contender;
      expect(mock.store.has('lock:account:1')).toBe(true);
      await releaseB();
    });

    it('throws a LockNotAcquiredException once retries are exhausted', async () => {
      const mock = createInMemoryRedis();
      const memLock = new RedisLock(mock.redis);

      const releaseA = await memLock.acquire('account:1', { retries: 0 });

      await expect(
        memLock.acquire('account:1', {
          retries: 3,
          baseDelayMs: 1,
          maxDelayMs: 5,
          jitterFactor: 0,
          timeoutMs: 10_000,
        } as LockAcquireOptions),
      ).rejects.toBeInstanceOf(LockNotAcquiredException);

      await releaseA();
    });
  });

  describe('tryAcquire', () => {
    it('resolves null instead of throwing on contention', async () => {
      const mock = createInMemoryRedis();
      const memLock = new RedisLock(mock.redis);

      const releaseA = await memLock.acquire('account:1', { retries: 0 });

      await expect(memLock.tryAcquire('account:1', { retries: 0 })).resolves.toBeNull();

      await releaseA();
      await expect(memLock.tryAcquire('account:1', { retries: 0 })).resolves.not.toBeNull();
    });
  });

  describe('release', () => {
    it('releases via the atomic compare-and-delete Lua script with the same token', async () => {
      const release = await lock.acquire('agent-1');
      await release();

      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(redis.eval.mock.calls[0][0]).toContain('redis.call');
      expect(redis.eval.mock.calls[0][1]).toBe(1);
      expect(redis.eval.mock.calls[0][2]).toBe('lock:agent-1');
      expect(redis.eval.mock.calls[0][3]).toBe(redis.set.mock.calls[0][1]);
    });

    it('is idempotent and never deletes a newer holder', async () => {
      const mock = createInMemoryRedis();
      const memRedis = mock.redis;
      const memLock = new RedisLock(memRedis);

      const releaseA = await memLock.acquire('account:1', { retries: 0 });
      await releaseA();
      await releaseA();
      expect(mock.store.has('lock:account:1')).toBe(false);

      // A compare-and-delete with a mismatched token must not delete the lock.
      const releaseB = await memLock.acquire('account:1', { retries: 0 });
      await memRedis.eval('', 1, 'lock:account:1', 'wrong-token');
      expect(mock.store.has('lock:account:1')).toBe(true);
      await releaseB();
    });
  });

  describe('withLock', () => {
    it('executes the handler and releases the lock afterwards', async () => {
      const fn = vi.fn().mockResolvedValue('done');

      const result = await lock.withLock('agent-1', fn);

      expect(result).toBe('done');
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });

    it('releases the lock even when the handler throws', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('boom'));

      await expect(lock.withLock('agent-1', fn)).rejects.toThrow('boom');
      expect(redis.eval).toHaveBeenCalledTimes(1);
    });

    it('fails fast without invoking the handler when the lock is held', async () => {
      redis.set.mockResolvedValue(null);
      const fn = vi.fn();

      await expect(lock.withLock('agent-1', fn)).rejects.toBeInstanceOf(LockNotAcquiredException);
      expect(fn).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('applies the default TTL when none is provided', async () => {
      await lock.withLock('agent-1', vi.fn().mockResolvedValue(undefined));
      expect(redis.set).toHaveBeenCalledWith('lock:agent-1', expect.any(String), 'PX', 5000, 'NX');
      expect(DEFAULT_LOCK_TTL_MS).toBe(5000);
    });
  });

  describe('concurrency', () => {
    it('serializes concurrent critical sections for the same key under load', async () => {
      const mock = createInMemoryRedis();
      const memLock = new RedisLock(mock.redis);

      const releaseA = await memLock.acquire('account:1', { retries: 0 });

      let active = 0;
      let maxActive = 0;
      const contended = async () => {
        const release = await memLock.acquire('account:1', {
          retries: 100,
          baseDelayMs: 1,
          maxDelayMs: 2,
          jitterFactor: 0,
          timeoutMs: 10_000,
        } as LockAcquireOptions);
        try {
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(2);
          active--;
        } finally {
          await release();
        }
      };

      const contenders = Promise.all([contended(), contended(), contended(), contended()]);
      await sleep(5);
      await releaseA();
      await contenders;

      expect(maxActive).toBe(1);
    });

    it('acquiring different keys does not interfere', async () => {
      const mock = createInMemoryRedis();
      const memLock = new RedisLock(mock.redis);

      const releaseA = await memLock.acquire('account:1', { retries: 0 });
      await expect(memLock.acquire('account:1', { retries: 0 })).rejects.toBeInstanceOf(
        LockNotAcquiredException,
      );
      await expect(memLock.acquire('account:2', { retries: 0 })).resolves.toBeDefined();

      await releaseA();
      await expect(memLock.acquire('account:1', { retries: 0 })).resolves.toBeDefined();
    });
  });

  it('disconnects the shared client on module destroy', () => {
    lock.onModuleDestroy();
    expect(redis.disconnect).toHaveBeenCalled();
  });
});
