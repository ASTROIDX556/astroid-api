import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/locks/locks.constants';
import { BalanceCacheConfig } from '../../../config/balance-cache.config';
import { StellarBalance } from '../../../integrations/stellar';

export interface CachedBalance {
  address: string;
  network: string;
  balances: StellarBalance[];
  cachedAt: number;
}

export interface BalanceThresholdConfig {
  /** Native XLM balance below which a low-balance event is emitted. */
  lowXlmThreshold: number;
  /** Asset balance below which a low-balance event is emitted for that asset. */
  lowAssetThresholds: Record<string, number>;
}

/** Fallback TTL when the config slice is not available (e.g. a bare unit test). */
const DEFAULT_TTL_SECONDS = 30;
/** Prefix of every key this service owns. */
export const BALANCE_CACHE_KEY_PREFIX = 'balance';

/**
 * Redis-backed cache-aside for Stellar account balances.
 *
 * Keeps frequently polled balance reads (agent dashboards, risk checks) off the
 * Horizon/Soroban RPC while guaranteeing that a confirmed transaction is not
 * masked by a stale entry:
 *
 * - Key shape: `balance:{environment}:{network}:{address}`. The environment
 *   namespace comes from config so two deployments sharing Redis never share
 *   an entry, and the network separates testnet from public for one address.
 * - TTL: `BALANCE_CACHE_TTL` seconds (conservative default 30). The entry is
 *   also rejected if its `cachedAt` is older than the TTL, so a Redis that
 *   did not apply the expiry can never serve stale data indefinitely.
 * - Invalidation: explicit `DEL` on every balance-affecting write (terminal
 *   transaction event, wallet archival). Cache-aside, never write-through.
 * - Failure mode: any Redis error is logged at warn level and treated as a
 *   miss, so the request falls through to the RPC instead of failing.
 * - Stampede: concurrent misses for the same key share one in-flight loader,
 *   so a burst of readers produces one upstream call.
 */
@Injectable()
export class BalanceCacheService {
  private readonly logger = new Logger(BalanceCacheService.name);
  private readonly ttlSeconds: number;
  private readonly environment: string;
  private readonly thresholds: BalanceThresholdConfig;

  /** Loaders currently running, keyed like the cache. */
  private readonly inFlight = new Map<string, Promise<StellarBalance[]>>();
  /**
   * Per-key generation counter, bumped by {@link invalidate}. A load that
   * started before an invalidation must not write its (pre-write) result back
   * into the cache after the key was deleted.
   */
  private readonly generations = new Map<string, number>();

  constructor(
    config: ConfigService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {
    const settings = config.get<BalanceCacheConfig>('balanceCache');
    this.ttlSeconds = settings?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.environment = settings?.environment ?? process.env.NODE_ENV ?? 'development';
    this.thresholds = {
      lowXlmThreshold: Number(process.env.LOW_XLM_THRESHOLD ?? 10),
      lowAssetThresholds: {},
    };
  }

  /**
   * Cache-aside read: returns the cached balances on a hit, otherwise invokes
   * `loader` once (deduplicating concurrent misses) and caches its result.
   * A Redis outage degrades to a plain `loader()` call.
   */
  async getOrLoad(
    address: string,
    network: string,
    loader: () => Promise<StellarBalance[]>,
  ): Promise<StellarBalance[]> {
    const key = this.cacheKey(address, network);
    const cached = await this.get(address, network);
    if (cached) {
      return cached.balances;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const generation = this.generationOf(key);
    const load = (async () => {
      const balances = await loader();
      // Skip the write when the key was invalidated (a transaction settled)
      // while the RPC call was running: the loaded snapshot may predate it.
      if (this.generationOf(key) === generation) {
        await this.set(address, network, balances);
      }
      return balances;
    })();

    this.inFlight.set(key, load);
    try {
      return await load;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Retrieves cached balances for a Stellar address.
   * Returns null when there is no usable entry: missing, malformed, older than
   * the TTL, Redis unavailable, or Redis not configured at all.
   */
  async get(address: string, network: string): Promise<CachedBalance | null> {
    const key = this.cacheKey(address, network);
    if (!this.redis) {
      return null;
    }

    try {
      const data = await this.redis.get(key);
      if (!data) {
        return null;
      }
      const entry = JSON.parse(data) as CachedBalance;
      if (!entry || !Array.isArray(entry.balances)) {
        this.logger.warn(`Discarding malformed balance cache entry ${key}`);
        return null;
      }
      if (Date.now() - entry.cachedAt >= this.ttlSeconds * 1000) {
        return null;
      }
      return entry;
    } catch (error) {
      this.logger.warn(`Redis get failed for ${key}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Stores balance data in cache with the configured TTL. */
  async set(address: string, network: string, balances: StellarBalance[]): Promise<void> {
    const key = this.cacheKey(address, network);
    if (!this.redis) {
      return;
    }

    const entry: CachedBalance = {
      address,
      network,
      balances,
      cachedAt: Date.now(),
    };

    try {
      await this.redis.setex(key, this.ttlSeconds, JSON.stringify(entry));
    } catch (error) {
      this.logger.warn(`Redis setex failed for ${key}: ${(error as Error).message}`);
    }
  }

  /**
   * Checks if any balance crosses a configured low-balance threshold.
   * Returns the list of assets that are below their thresholds.
   */
  checkThresholds(balances: StellarBalance[]): Array<{
    asset: string;
    balance: string;
    threshold: number;
  }> {
    const alerts: Array<{ asset: string; balance: string; threshold: number }> = [];

    for (const bal of balances) {
      const balanceNum = parseFloat(bal.balance);
      let threshold: number | undefined;

      if (bal.asset === 'XLM' || bal.assetType === 'native') {
        threshold = this.thresholds.lowXlmThreshold;
      } else {
        threshold = this.thresholds.lowAssetThresholds[bal.asset];
      }

      if (threshold !== undefined && balanceNum < threshold) {
        alerts.push({
          asset: bal.asset,
          balance: bal.balance,
          threshold,
        });
      }
    }

    return alerts;
  }

  /**
   * Invalidates the cached balance for a specific address. Called on every
   * balance-affecting write; failures are logged and never thrown, so a Redis
   * outage cannot roll back the write that triggered the invalidation.
   */
  async invalidate(address: string, network: string): Promise<void> {
    const key = this.cacheKey(address, network);
    // Bump the generation first so an in-flight load cannot repopulate the key.
    this.generations.set(key, this.generationOf(key) + 1);
    this.inFlight.delete(key);

    if (!this.redis) {
      return;
    }

    try {
      await this.redis.del(key);
    } catch (error) {
      this.logger.warn(`Redis del failed for ${key}: ${(error as Error).message}`);
    }
  }

  /** Returns the configured cache TTL in seconds. */
  getTtlSeconds(): number {
    return this.ttlSeconds;
  }

  /** Returns the namespace folded into every key. */
  getEnvironment(): string {
    return this.environment;
  }

  /** The full cache key of a wallet on a network. Exposed for diagnostics. */
  cacheKey(address: string, network: string): string {
    return `${BALANCE_CACHE_KEY_PREFIX}:${this.environment}:${network}:${address}`;
  }

  private generationOf(key: string): number {
    return this.generations.get(key) ?? 0;
  }
}
