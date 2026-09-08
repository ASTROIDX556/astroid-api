import { SetMetadata } from '@nestjs/common';

export const THROTTLE_TIER_KEY = 'astroid:throttleTier';

export type ThrottleTier = 'auth' | 'api';

/**
 * Selects the rate-limit tier for a route. `auth` = 10/min, `api` = 120/min.
 * Defaults to `api` when unset. Consumed by the AstroidThrottlerGuard.
 */
export const ThrottleTierDecorator = (tier: ThrottleTier) =>
  SetMetadata(THROTTLE_TIER_KEY, tier);
