/**
 * The routes guarded by `SensitiveRateLimitGuard` and the policy each one
 * follows. The limits themselves are configuration (`rateLimit.sensitive`,
 * `RATE_LIMIT_<ROUTE>_*`); what happens when Redis is unavailable and how the
 * caller is identified are fixed here, so a deployment cannot configure a
 * credential route into failing open.
 */

/** Metadata key set by `@SensitiveRateLimit()`. */
export const SENSITIVE_RATE_LIMIT_KEY = 'astroid:sensitiveRateLimit';

export type SensitiveRoute =
  | 'login'
  | 'refresh'
  | 'apiKeyCreate'
  | 'webhookCreate'
  | 'webhookRotateSecret';

/**
 * What the guard does when it cannot reach Redis:
 *  - `closed`: refuse with 503 `RATE_LIMIT_UNAVAILABLE`. Used where an unlimited
 *    window would let an attacker guess passwords or mint credentials at will.
 *  - `open`: allow the request and log a warning. Used where the route needs an
 *    authenticated principal already and an outage should not block normal work.
 */
export type RateLimitFailureMode = 'closed' | 'open';

/**
 * Who a request is counted against:
 *  - `ip`: the client IP. For routes reached before authentication.
 *  - `principal`: the API key or user that authenticated the request, so one
 *    tenant cannot spend another's budget behind a shared address.
 */
export type RateLimitIdentity = 'ip' | 'principal';

export interface SensitiveRoutePolicy {
  failureMode: RateLimitFailureMode;
  identity: RateLimitIdentity;
}

export const SENSITIVE_ROUTE_POLICY: Record<SensitiveRoute, SensitiveRoutePolicy> = {
  // Credential tier: fail closed.
  login: { failureMode: 'closed', identity: 'ip' },
  refresh: { failureMode: 'closed', identity: 'ip' },
  apiKeyCreate: { failureMode: 'closed', identity: 'principal' },
  // Management tier: fail open with a warning.
  webhookCreate: { failureMode: 'open', identity: 'principal' },
  webhookRotateSecret: { failureMode: 'open', identity: 'principal' },
};
