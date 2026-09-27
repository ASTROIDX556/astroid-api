import { registerAs } from '@nestjs/config';
import { ThrottlerModuleOptions, ThrottlerOptions, ThrottlerStorage } from '@nestjs/throttler';
import { throttleEnvSchema, validateEnv } from './env.validation';

/**
 * The object form of {@link ThrottlerModuleOptions} — the only form that can
 * carry a `storage` implementation.
 */
export type TieredThrottlerOptions = Exclude<ThrottlerModuleOptions, ThrottlerOptions[]>;

export type ThrottlerConfig = {
  /** Fixed-window length in seconds, shared by every tier. */
  windowSeconds: number;
  /** Requests allowed per window on the public `api` tier. */
  apiLimit: number;
  /** Requests allowed per window on the sensitive `auth` tier. */
  authLimit: number;
};

/**
 * Rate-limit configuration, driven by the `THROTTLE_*` environment variables.
 *
 * Historically these values lived under the `queue` namespace even though
 * BullMQ never read them — they only ever configured `@nestjs/throttler`. The
 * dedicated `throttler` namespace makes the ownership explicit.
 */
export const throttlerConfig = registerAs('throttler', (): ThrottlerConfig => {
  const env = validateEnv(throttleEnvSchema, process.env);
  return {
    windowSeconds: env.THROTTLE_TTL,
    apiLimit: env.THROTTLE_API_LIMIT,
    authLimit: env.THROTTLE_AUTH_LIMIT,
  };
});

/**
 * Builds the two tiered throttlers consumed by `AstroidThrottlerGuard`:
 *  - `api`  — every route that does not declare a tier explicitly
 *  - `auth` — routes marked with `@ThrottleTierDecorator('auth')`
 *
 * The options must be returned in the object form (not the bare array) so the
 * shared Redis {@link ThrottlerStorage} can be attached: `@nestjs/throttler`
 * only honours `storage` when the options are an object.
 *
 * `blockDuration` is intentionally left unset so it defaults to the window
 * `ttl` — a client that exhausts its quota waits out one full window.
 */
export function createThrottlerOptions(
  config: ThrottlerConfig,
  storage?: ThrottlerStorage,
): TieredThrottlerOptions {
  const ttl = config.windowSeconds * 1000;

  return {
    ...(storage ? { storage } : {}),
    throttlers: [
      { name: 'api', ttl, limit: config.apiLimit },
      { name: 'auth', ttl, limit: config.authLimit },
    ],
  };
}
