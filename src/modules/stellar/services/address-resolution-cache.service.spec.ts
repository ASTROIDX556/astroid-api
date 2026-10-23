import { describe, expect, it, vi } from 'vitest';
import { AddressResolutionCacheService } from './address-resolution-cache.service';

describe('AddressResolutionCacheService (#309)', () => {
  it('returns cached identity within TTL without invoking external resolver twice', async () => {
    const cache = new AddressResolutionCacheService(5_000, 2);
    const resolver = vi.fn().mockImplementation(async (k: string) => ({
      address: 'GABC123',
      label: k,
      resolvedAt: 1000,
    }));

    const first = await cache.resolve('treasury.astroid', resolver, 1000);
    const second = await cache.resolve('TREASURY.ASTROID', resolver, 2000);

    expect(first).toEqual(second);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(cache.getStats()).toEqual({
      hits: 1,
      misses: 1,
      size: 1,
      hitRatio: 0.5,
    });
  });

  it('evicts oldest entry when maxEntries capacity is reached and supports invalidation', async () => {
    const cache = new AddressResolutionCacheService(10_000, 2);
    const resolver = vi.fn().mockImplementation(async (k: string) => ({
      address: `G_${k}`,
      label: k,
      resolvedAt: 1000,
    }));

    await cache.resolve('a.eth', resolver, 1000);
    await cache.resolve('b.eth', resolver, 1000);
    await cache.resolve('c.eth', resolver, 1000);

    expect(cache.getStats().size).toBe(2);
    expect(cache.invalidate('b.eth')).toBe(true);
    expect(cache.getStats().size).toBe(1);
  });
});
