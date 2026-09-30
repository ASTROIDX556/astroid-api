import { SetMetadata } from '@nestjs/common';

export const THROTTLE_TIER_KEY = 'astroid:throttleTier';

export type ThrottleTier = 'auth' | 'api' | 'agent';

/**
 * Selects the rate-limit tier for a route:
 * `auth` = 10/min, `api` = 120/min, `agent` = 300/min.
 * Defaults to `api` when unset (agent-identified traffic is auto-detected by
 * `AgentThrottlerGuard` even without this decorator).
 */
export const ThrottleTierDecorator = (tier: ThrottleTier) =>
  SetMetadata(THROTTLE_TIER_KEY, tier);
