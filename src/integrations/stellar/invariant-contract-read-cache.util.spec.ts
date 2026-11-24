import { describe, expect, it, vi } from 'vitest';
import { InvariantContractReadCache } from './invariant-contract-read-cache.util';

describe('InvariantContractReadCache (#303)', () => {
  it('caches invariant contract metadata reads within TTL', async () => {
    const cache = new InvariantContractReadCache<number>(60_000, 10);
    const reader = vi.fn().mockResolvedValue(7);

    const d1 = await cache.getOrRead('CCONTRACT1', 'decimals', [], reader, 1000);
    const d2 = await cache.getOrRead('CCONTRACT1', 'decimals', [], reader, 2000);

    expect(d1).toBe(7);
    expect(d2).toBe(7);
    expect(reader).toHaveBeenCalledTimes(1);
  });
});
