import { SetMetadata } from '@nestjs/common';

export const THROTTLE_TIER_KEY = 'astroid:throttleTier';

export type ThrottleTier = 'auth' | 'api' | 'webhook';

/**
 * Selects the rate-limit tier for a route:
 *   - `auth`    = sensitive auth endpoints (login, register, passkey)
 *   - `api`     = general API traffic (default)
 *   - `webhook` = webhook delivery callbacks (stricter)
 *
 * Defaults to `api` when unset. Consumed by the AstroidThrottlerGuard.
 */
export const ThrottleTierDecorator = (tier: ThrottleTier) =>
  SetMetadata(THROTTLE_TIER_KEY, tier);
