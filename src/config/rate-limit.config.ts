import { registerAs } from '@nestjs/config';
import { rateLimitEnvSchema, validateEnv } from './env.validation';

export type RateLimitConfig = {
  windowSeconds: number;
  maxRequests: number;
};

/** Config for the Redis-backed sliding-window rate limiter guard. */
export const rateLimitConfig = registerAs('rateLimit', (): RateLimitConfig => {
  const env = validateEnv(rateLimitEnvSchema, process.env);
  return {
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
  };
});
