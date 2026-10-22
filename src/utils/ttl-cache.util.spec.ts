import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TtlCache } from './ttl-cache.util';

describe('TtlCache', () => {
  describe('hits and misses', () => {
    it('returns undefined and counts a miss for an unknown key', () => {
      const cache = new TtlCache();
      expect(cache.get('missing')).toBeUndefined();
      expect(cache.stats).toEqual({ hits: 0, misses: 1 });
    });

    it('returns the stored value and counts a hit', () => {
      const cache = new TtlCache();
      cache.set('k', { id: 'stream-1' });
      expect(cache.get('k')).toEqual({ id: 'stream-1' });
      expect(cache.stats).toEqual({ hits: 1, misses: 0 });
    });

    it('stores multiple keys independently', () => {
      const cache = new TtlCache();
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.get<number>('a')).toBe(1);
      expect(cache.get<number>('b')).toBe(2);
      expect(cache.size).toBe(2);
    });

    it('reports has() without affecting hit/miss stats', () => {
      const cache = new TtlCache();
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
      expect(cache.stats).toEqual({ hits: 0, misses: 0 });
    });

    it('delete() removes an entry and clear() empties the cache', () => {
      const cache = new TtlCache();
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.delete('a')).toBe(true);
      expect(cache.delete('a')).toBe(false);
      expect(cache.get('a')).toBeUndefined();
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.stats).toEqual({ hits: 0, misses: 0 });
    });
  });

  describe('TTL expiry', () => {
    it('expires an entry once its TTL elapses', () => {
      let nowMs = 1_000;
      const cache = new TtlCache({ ttlMs: 500, now: () => nowMs });

      cache.set('k', 'v');
      nowMs = 1_499;
      expect(cache.get('k')).toBe('v');

      nowMs = 1_500;
      expect(cache.get('k')).toBeUndefined();
      expect(cache.size).toBe(0); // dropped lazily on the expired read
    });

    it('honours a per-call TTL override', () => {
      let nowMs = 0;
      const cache = new TtlCache({ ttlMs: 10_000, now: () => nowMs });

      cache.set('short', 'v', 100);
      nowMs = 101;
      expect(cache.get('short')).toBeUndefined();
    });

    it('does not serve expired entries via has()', () => {
      let nowMs = 0;
      const cache = new TtlCache({ ttlMs: 100, now: () => nowMs });
      cache.set('k', 'v');
      nowMs = 101;
      expect(cache.has('k')).toBe(false);
    });
  });

  describe('bounded size and LRU eviction', () => {
    it('evicts the oldest entry once maxEntries is exceeded', () => {
      const cache = new TtlCache({ maxEntries: 2 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      expect(cache.size).toBe(2);
      expect(cache.get('a')).toBeUndefined(); // oldest evicted
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
    });

    it('evicts the least recently *used* entry, not merely the oldest', () => {
      const cache = new TtlCache({ maxEntries: 2 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a'); // 'a' becomes most recently used
      cache.set('c', 3); // over capacity → evicts 'b'

      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe(1);
      expect(cache.get('c')).toBe(3);
      expect(cache.size).toBe(2);
    });

    it('replaces an existing key without growing past capacity', () => {
      const cache = new TtlCache({ maxEntries: 1 });
      cache.set('a', 1);
      cache.set('a', 2);
      expect(cache.size).toBe(1);
      expect(cache.get('a')).toBe(2);
    });
  });

  describe('getOrSet', () => {
    it('loads on a miss and serves the cached value on the next call', async () => {
      const cache = new TtlCache();
      const loader = vi.fn().mockResolvedValue({ immutable: true });

      await expect(cache.getOrSet('k', loader)).resolves.toEqual({ immutable: true });
      await expect(cache.getOrSet('k', loader)).resolves.toEqual({ immutable: true });

      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('bypasses the cache when fresh data is required and refreshes the entry', async () => {
      const cache = new TtlCache();
      const loader = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');

      await expect(cache.getOrSet('k', loader)).resolves.toBe('stale');
      await expect(cache.getOrSet('k', loader, { bypass: true })).resolves.toBe('fresh');
      await expect(cache.getOrSet('k', loader)).resolves.toBe('fresh');

      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('does not cache loader failures', async () => {
      const cache = new TtlCache();
      const loader = vi
        .fn()
        .mockRejectedValueOnce(new Error('upstream down'))
        .mockResolvedValueOnce('recovered');

      await expect(cache.getOrSet('k', loader)).rejects.toThrow('upstream down');
      await expect(cache.getOrSet('k', loader)).resolves.toBe('recovered');
      expect(loader).toHaveBeenCalledTimes(2);
    });

    it('expires loaded values after the per-call TTL', async () => {
      let nowMs = 0;
      const cache = new TtlCache({ now: () => nowMs });
      const loader = vi.fn().mockResolvedValue('v');

      await cache.getOrSet('k', loader, { ttlMs: 10 });
      nowMs = 11;
      await expect(cache.getOrSet('k', loader)).resolves.toBe('v');
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });

  describe('hit rate measurement', () => {
    it('tracks hits and misses so callers can observe the hit rate', async () => {
      const cache = new TtlCache();
      const loader = vi.fn().mockResolvedValue('v');

      await cache.getOrSet('k', loader); // miss + load
      await cache.getOrSet('k', loader); // hit
      await cache.getOrSet('k', loader); // hit

      const { hits, misses } = cache.stats;
      expect(hits).toBe(2);
      expect(misses).toBe(1);
      expect(hits / (hits + misses)).toBeCloseTo(2 / 3);
    });
  });

  describe('with real timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('serves values until the TTL passes under fake timers', async () => {
      const cache = new TtlCache({ ttlMs: 1_000 });
      cache.set('k', 'v');

      await vi.advanceTimersByTimeAsync(999);
      expect(cache.get('k')).toBe('v');

      await vi.advanceTimersByTimeAsync(1);
      expect(cache.get('k')).toBeUndefined();
    });
  });
});
