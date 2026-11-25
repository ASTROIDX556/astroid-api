import { ThrottleTier } from '../decorators/throttle-tier.decorator';

/**
 * A rule binding a set of API key permission scopes to a rate-limit tier.
 *
 * Scopes are the fine-grained permissions an API key is issued with (see
 * `ApiKey.permissions` in the Prisma schema). Because they describe *what* a
 * key is allowed to do, they also describe how much traffic that key may
 * generate: a key that can rotate credentials is far more valuable — and far
 * more dangerous — than one that can only read wallets.
 */
export interface ApiKeyScopeTierRule {
  /** The tier enforced for the scopes matched by this rule. */
  readonly tier: ThrottleTier;
  /** Scope resources (the segment before `:`) covered by the rule. */
  readonly resources: readonly string[];
  /** Exact `resource:action` scopes covered by the rule. */
  readonly scopes?: readonly string[];
}

/**
 * Mapping between API key permission scopes and rate-limit tiers.
 *
 * - `auth`    — credential, session and key-management scopes. Tightest tier,
 *               because a leaked key of this kind can mint new credentials.
 * - `webhook` — webhook management scopes. Tighter than the generic API tier
 *               because a key that can re-point a destination can redirect
 *               every event the tenant emits.
 * - `agent`   — autonomous-agent control scopes. These drive the high-volume
 *               agent traffic the platform expects, so they are looser than
 *               the generic API tier and are only tightened when the route
 *               itself declares a stricter tier.
 *
 * Scopes that match no rule (`transactions:read`, `wallets:read`, `*`, …) leave
 * the route-declared tier in force, so ordinary read-only keys are unaffected.
 */
export const API_KEY_SCOPE_TIER_RULES: readonly ApiKeyScopeTierRule[] = [
  {
    tier: 'auth',
    resources: [
      'auth',
      'session',
      'sessions',
      'credential',
      'credentials',
      'apikey',
      'apikeys',
      'token',
      'tokens',
    ],
  },
  {
    tier: 'webhook',
    resources: ['webhook', 'webhooks'],
  },
  {
    tier: 'agent',
    resources: ['agent', 'agents'],
    scopes: ['transactions:execute', 'transactions:submit', 'transactions:sign'],
  },
];

/**
 * How restrictive each tier is — a higher number means a tighter budget.
 *
 * Used to pick the single tier that governs a key that holds scopes from more
 * than one rule, and as the fallback comparison when the configured per-tier
 * limits are not available (e.g. before the throttler options are resolved).
 *
 * The ordering mirrors the shipped defaults (`THROTTLE_AUTH_LIMIT` 10,
 * `THROTTLE_WEBHOOK_LIMIT` 30, `THROTTLE_API_LIMIT` 120,
 * `THROTTLE_AGENT_LIMIT` 300).
 */
export const TIER_RESTRICTIVENESS: Readonly<Record<ThrottleTier, number>> = {
  auth: 3,
  webhook: 2,
  agent: 1,
  api: 0,
};

/**
 * Resolves the tier a single scope belongs to, or `undefined` when the scope
 * does not constrain the rate limit.
 *
 * Matching is case-insensitive and understands the wildcard forms used by
 * `ScopesGuard` (`agents:*` matches the `agents` resource, a global `*` grants
 * everything and therefore constrains nothing).
 */
export function matchApiKeyScopeTier(scope: string): ThrottleTier | undefined {
  if (typeof scope !== 'string') {
    return undefined;
  }

  const normalized = scope.trim().toLowerCase();
  if (!normalized || normalized === '*' || normalized === 'admin') {
    return undefined;
  }

  const [resource] = normalized.split(':');

  for (const rule of API_KEY_SCOPE_TIER_RULES) {
    if (rule.scopes?.includes(normalized)) {
      return rule.tier;
    }
    if (rule.resources.includes(resource)) {
      return rule.tier;
    }
  }

  return undefined;
}

/**
 * Resolves the single tier that governs a key holding the given scopes.
 *
 * When several rules match, the **most restrictive** tier wins: a key that can
 * both rotate credentials and read wallets is governed by the credential
 * budget, not the wallet one. `undefined` is returned when no scope matches a
 * rule, meaning the route-declared tier stays in force.
 */
export function resolveApiKeyScopeTier(
  scopes: readonly string[] | undefined | null,
): ThrottleTier | undefined {
  let resolved: ThrottleTier | undefined;

  for (const scope of scopes ?? []) {
    const tier = matchApiKeyScopeTier(scope);
    if (!tier) {
      continue;
    }
    if (!resolved || TIER_RESTRICTIVENESS[tier] > TIER_RESTRICTIVENESS[resolved]) {
      resolved = tier;
    }
  }

  return resolved;
}
