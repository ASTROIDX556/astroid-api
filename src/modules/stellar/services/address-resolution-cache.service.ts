import { Injectable } from '@nestjs/common';

export interface ResolvedAddressIdentity {
  address: string;
  label: string;
  resolvedAt: number;
}

export interface AddressResolutionCacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRatio: number;
}

@Injectable()
export class AddressResolutionCacheService {
  private readonly cache = new Map<
    string,
    { value: ResolvedAddressIdentity; expiresAt: number }
  >();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly ttlMs: number = 60_000,
    private readonly maxEntries: number = 500,
  ) {}

  async resolve(
    key: string,
    resolver: (normalizedKey: string) => Promise<ResolvedAddressIdentity>,
    now: number = Date.now(),
  ): Promise<ResolvedAddressIdentity> {
    const normalized = key.trim().toLowerCase();
    const existing = this.cache.get(normalized);

    if (existing && existing.expiresAt > now) {
      this.hits += 1;
      this.cache.delete(normalized);
      this.cache.set(normalized, existing);
      return existing.value;
    }

    if (existing) {
      this.cache.delete(normalized);
    }

    this.misses += 1;
    const resolved = await resolver(normalized);

    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(normalized, {
      value: resolved,
      expiresAt: now + this.ttlMs,
    });
    return resolved;
  }

  invalidate(key: string): boolean {
    return this.cache.delete(key.trim().toLowerCase());
  }

  getStats(): AddressResolutionCacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      hitRatio: total === 0 ? 0 : this.hits / total,
    };
  }
}
