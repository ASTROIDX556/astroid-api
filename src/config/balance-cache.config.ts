import { registerAs } from '@nestjs/config';
import { balanceCacheEnvSchema, validateEnv } from './env.validation';

export type BalanceCacheConfig = {
  /**
   * Staleness window in seconds. A cached balance is served for at most this
   * long before it is re-read from the Stellar RPC.
   */
  ttlSeconds: number;
  /**
   * Namespace folded into every cache key, so deployments that share a Redis
   * instance (or the same database index) never read each other's entries.
   */
  environment: string;
};

/**
 * Redis cache settings for wallet balance reads (`BALANCE_CACHE_TTL`,
 * `BALANCE_CACHE_ENV`). See `docs/balance-cache.md`.
 */
export const balanceCacheConfig = registerAs('balanceCache', (): BalanceCacheConfig => {
  const env = validateEnv(balanceCacheEnvSchema, process.env);
  return {
    ttlSeconds: env.BALANCE_CACHE_TTL,
    environment: env.BALANCE_CACHE_ENV,
  };
});
