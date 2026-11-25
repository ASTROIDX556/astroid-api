/**
 * Bounded in-memory cache with per-entry TTL and LRU eviction, intended for
 * *immutable* reads (e.g. stream/contract metadata that never changes once
 * written) where repeated queries would otherwise hammer external subgraph or
 * RPC endpoints.
 *
 * Design notes:
 * - Single-process, synchronous `Map` lookups: no I/O, no locks — every
 *   operation is O(1) and atomic with respect to Node's event loop.
 * - Memory stays bounded: at most `maxEntries` are kept; the least recently
 *   used entry is evicted first, so the cache can never leak across a long
 *   application lifetime.
 * - Staleness stays bounded: entries expire after `ttlMs` (lazily on read).
 */

/** A cached value plus the epoch-ms deadline after which it is stale. */
interface TtlCacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface TtlCacheOptions {
  /** Default time-to-live for entries in milliseconds. Default: 60_000. */
  ttlMs?: number;
  /** Maximum entries retained; the least recently used is evicted first. Default: 500. */
  maxEntries?: number;
  /** Clock injection point so tests can control expiry deterministically. Default: `Date.now`. */
  now?: () => number;
}

export interface TtlCacheGetOrSetOptions {
  /** Skip the cache read and fetch fresh data; the result still refreshes the entry. Default: false. */
  bypass?: boolean;
  /** Per-call TTL override in milliseconds. */
  ttlMs?: number;
}

/** Snapshot of cache effectiveness, handy for assertions and metrics. */
export interface TtlCacheStats {
  hits: number;
  misses: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 500;

export class TtlCache {
  private readonly entries = new Map<string, TtlCacheEntry<unknown>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(options: TtlCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Returns the fresh cached value, or `undefined` on miss/expiry. A hit also refreshes recency. */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      // Lazy expiry: drop the stale entry so it can never be served again.
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Re-insert to mark the entry as most recently used for LRU eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value as T;
  }

  /** Stores a value, evicting the least recently used entry when over capacity. */
  set<T>(key: string, value: T, ttlMs: number = this.ttlMs): void {
    // Replace in place so recency and deadline are both refreshed.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string;
      this.entries.delete(oldestKey);
    }
  }

  /**
   * Returns the cached value for `key`, loading it via `loader` on a miss.
   * `bypass: true` forces a fresh load (fresh data is explicitly required);
   * the fresh value then replaces the cache entry. Loader failures are never
   * cached — the error propagates and the next call retries the loader.
   */
  async getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    options: TtlCacheGetOrSetOptions = {},
  ): Promise<T> {
    if (!options.bypass) {
      const cached = this.get<T>(key);
      if (cached !== undefined) {
        return cached;
      }
    }
    const value = await loader();
    this.set(key, value, options.ttlMs);
    return value;
  }

  /** True when a *fresh* (non-expired) entry exists. Does not affect hit/miss stats. */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.expiresAt > this.now();
  }

  /** Removes a single entry. Returns false when it was absent. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Drops every entry (and resets hit/miss counters). */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Current number of live entries (expired-but-unread entries may linger until read or evicted). */
  get size(): number {
    return this.entries.size;
  }

  /** Hit/miss counters since construction or the last `clear()`. */
  get stats(): TtlCacheStats {
    return { hits: this.hits, misses: this.misses };
  }
}
