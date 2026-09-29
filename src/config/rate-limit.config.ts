import { registerAs } from '@nestjs/config';
import { rateLimitEnvSchema, validateEnv } from './env.validation';

/** Settings for the IP-based limiter applied to unauthenticated routes. */
export type PublicRateLimitConfig = {
  enabled: boolean;
  maxRequests: number;
  windowSeconds: number;
  trustProxy: boolean;
};

export type RateLimitConfig = {
  windowSeconds: number;
  maxRequests: number;
  public: PublicRateLimitConfig;
};

/**
 * Config for the Redis-backed sliding-window rate limiters: the per-route
 * `SlidingWindowThrottlerGuard` (top-level fields) and the IP-based
 * `PublicRateLimitGuard` for public endpoints (`public`).
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
    },
  };
});
