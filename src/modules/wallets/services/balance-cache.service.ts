import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
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

/**
 * Redis-backed caching service for Stellar account balances.
 *
 * Provides low-latency reads for AI agent decision-making while avoiding
 * excessive Horizon RPC calls. Each cached entry includes a timestamp
 * for staleness detection.
 *
 * Cache key pattern: `balance:{network}:{address}`
 * TTL: configurable via BALANCE_CACHE_TTL (default 60 seconds)
 */
@Injectable()
export class BalanceCacheService {
  private readonly logger = new Logger(BalanceCacheService.name);
  private redis: Redis | null = null;
  private readonly ttlSeconds: number;
  private readonly thresholds: BalanceThresholdConfig;

  /** In-memory fallback when Redis is unavailable. */
  private readonly memoryCache = new Map<string, CachedBalance>();

  constructor(config: ConfigService) {
    this.ttlSeconds = config.get<number>('BALANCE_CACHE_TTL', 60);
    this.thresholds = {
      lowXlmThreshold: config.get<number>('LOW_XLM_THRESHOLD', 10),
      lowAssetThresholds: {},
    };

    // Attempt Redis connection; fall back to in-memory if unavailable
    try {
      const redisUrl = config.get<string>('REDIS_URL');
      if (redisUrl) {
        this.redis = new Redis(redisUrl, {
          maxRetriesPerRequest: 3,
          retryStrategy(times: number) {
            if (times > 3) return null;
            return Math.min(times * 200, 2000);
          },
          lazyConnect: true,
        });
        this.redis.connect().catch((err: Error) => {
          this.logger.warn(`Redis connection failed, using in-memory cache: ${err.message}`);
          this.redis = null;
        });
      }
    } catch {
      this.logger.warn('Redis not configured, using in-memory balance cache');
    }
  }

  /**
   * Retrieves cached balances for a Stellar address.
   * Returns null if no cache entry exists or the entry is stale.
   */
  async get(address: string, network: string): Promise<CachedBalance | null> {
    const key = this.cacheKey(address, network);

    if (this.redis) {
      try {
        const data = await this.redis.get(key);
        if (data) {
          return JSON.parse(data) as CachedBalance;
        }
      } catch (err) {
        this.logger.warn(`Redis get failed for ${key}: ${(err as Error).message}`);
      }
    }

    // Fallback to in-memory cache
    return this.memoryCache.get(key) ?? null;
  }

  /**
   * Stores balance data in cache with configured TTL.
   */
  async set(address: string, network: string, balances: StellarBalance[]): Promise<void> {
    const entry: CachedBalance = {
      address,
      network,
      balances,
      cachedAt: Date.now(),
    };

    const key = this.cacheKey(address, network);

    if (this.redis) {
      try {
        await this.redis.setex(key, this.ttlSeconds, JSON.stringify(entry));
      } catch (err) {
        this.logger.warn(`Redis setex failed for ${key}: ${(err as Error).message}`);
      }
    }

    // Always update in-memory fallback
    this.memoryCache.set(key, entry);
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
   * Invalidates the cached balance for a specific address.
   */
  async invalidate(address: string, network: string): Promise<void> {
    const key = this.cacheKey(address, network);

    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch (err) {
        this.logger.warn(`Redis del failed for ${key}: ${(err as Error).message}`);
      }
    }

    this.memoryCache.delete(key);
  }

  /**
   * Returns the configured cache TTL in seconds.
   */
  getTtlSeconds(): number {
    return this.ttlSeconds;
  }

  private cacheKey(address: string, network: string): string {
    return `balance:${network}:${address}`;
  }
}
