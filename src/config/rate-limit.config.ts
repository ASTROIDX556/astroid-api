import { registerAs } from '@nestjs/config';
import { rateLimitEnvSchema, validateEnv } from './env.validation';
import { SensitiveRoute } from '../common/throttler/sensitive-route-policy';

/** Client identifiers that can participate in the public rate-limit bucket. */
export type PublicRateLimitIdentifier = 'ip' | 'apiKey';

/** Settings for the IP-based limiter applied to unauthenticated routes. */
export type PublicRateLimitConfig = {
  enabled: boolean;
  maxRequests: number;
  windowSeconds: number;
  trustProxy: boolean;
  /**
   * Identifiers folded into the bucket key. The client IP always
   * participates; 'apiKey' additionally separates key-holding clients
   * behind a shared address. Order defines bucket-key composition.
   */
  clientIdentifiers: PublicRateLimitIdentifier[];
};

/** Limit of one sensitive route: requests per sliding window. */
export type SensitiveRouteLimit = {
  maxRequests: number;
  windowSeconds: number;
};

export type RateLimitConfig = {
  windowSeconds: number;
  maxRequests: number;
  public: PublicRateLimitConfig;
  /** Per-route limits of the `@SensitiveRateLimit` guard. */
  sensitive: Record<SensitiveRoute, SensitiveRouteLimit>;
};

/**
 * Parses the `PUBLIC_RATE_LIMIT_CLIENT_IDENTIFIERS` list. Unknown entries are
 * ignored so a typo cannot break startup; the IP always participates anyway.
 *
 * Read outside the Zod environment schema (same pattern as
 * `BALANCE_CACHE_TTL`) so the schema file keeps a fixed set of keys.
 */
function parseClientIdentifiers(raw: string | undefined): PublicRateLimitIdentifier[] {
  if (!raw) {
    return [];
  }
  const known: PublicRateLimitIdentifier[] = ['ip', 'apiKey'];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is PublicRateLimitIdentifier =>
      known.includes(entry as PublicRateLimitIdentifier),
    );
}

/**
 * Config for the Redis-backed sliding-window rate limiters: the per-route
 * `SlidingWindowThrottlerGuard` (top-level fields), the IP-based
 * `PublicRateLimitGuard` for public endpoints (`public`) and the
 * `SensitiveRateLimitGuard` for credential and webhook routes (`sensitive`).
 */
export const rateLimitConfig = registerAs('rateLimit', (): RateLimitConfig => {
  const env = validateEnv(rateLimitEnvSchema, process.env);
  return {
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    public: {
      enabled: env.PUBLIC_RATE_LIMIT_ENABLED,
      maxRequests: env.PUBLIC_RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: env.PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
      trustProxy: env.PUBLIC_RATE_LIMIT_TRUST_PROXY,
      clientIdentifiers: parseClientIdentifiers(process.env.PUBLIC_RATE_LIMIT_CLIENT_IDENTIFIERS),
    },
    sensitive: {
      login: {
        maxRequests: env.RATE_LIMIT_LOGIN_MAX,
        windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
      },
      refresh: {
        maxRequests: env.RATE_LIMIT_REFRESH_MAX,
        windowSeconds: env.RATE_LIMIT_REFRESH_WINDOW_SECONDS,
      },
      apiKeyCreate: {
        maxRequests: env.RATE_LIMIT_API_KEY_CREATE_MAX,
        windowSeconds: env.RATE_LIMIT_API_KEY_CREATE_WINDOW_SECONDS,
      },
      webhookCreate: {
        maxRequests: env.RATE_LIMIT_WEBHOOK_CREATE_MAX,
        windowSeconds: env.RATE_LIMIT_WEBHOOK_CREATE_WINDOW_SECONDS,
      },
      webhookRotateSecret: {
        maxRequests: env.RATE_LIMIT_WEBHOOK_ROTATE_MAX,
        windowSeconds: env.RATE_LIMIT_WEBHOOK_ROTATE_WINDOW_SECONDS,
      },
    },
  };
});
