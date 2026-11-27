# Rate Limiting

The API protects itself with several independent rate limiters. Every limiter
keeps its counters in Redis, so the limits hold across all replicas of the
service.

| Limiter | Scope | Where it is applied |
| --- | --- | --- |
| `AstroidThrottlerGuard` | Per API key → per user → per organization → per IP | Every route (global guard) |
| `CredentialRateLimitGuard` | Per verified API key → per user → per IP, minute **and** day quota | Every route except health/readiness and `/metrics` (global guard) |
| `AgentThrottlerGuard` | Per acting agent → per organization → per API key → per IP | Agent-facing controllers |
| `SlidingWindowThrottlerGuard` | Per acting agent → per API key → per organization → per IP | Transaction submission, agent commands, webhook ingress |
| `PublicRateLimitGuard` | Per IP (and API key when present) | Unauthenticated routes |
| `AgentRateLimiterGuard` | Per agent, with the limit taken from the agent metadata | `POST /agents/:id/execute` |
| `SensitiveRateLimitGuard` | Per route, then per client IP or per API key / user | Login, refresh, API-key creation, webhook creation and secret rotation |

## Per-credential quota

`CredentialRateLimitGuard` is a global guard registered **after** authentication,
so the counter is keyed by the identity the authentication guards verified:

1. the API key id (`apikey:<id>`) — never the raw key or an unverified header,
2. the JWT subject (`user:<id>`),
3. the client IP (`ip:<address>`), honouring `x-forwarded-for` only when
   `PUBLIC_RATE_LIMIT_TRUST_PROXY` is enabled.

Every request is measured against **two sliding windows at once**: the trailing
minute and trailing day. A request is counted only when it fits in both;
rejected requests consume nothing.

| Budget | Default | Variable | Per-key override |
| --- | --- | --- | --- |
| Requests per minute | `120` | `RATE_LIMIT_CREDENTIAL_PER_MINUTE` | `rateLimitPerMinute` |
| Length of the minute window | `60` s | `RATE_LIMIT_CREDENTIAL_MINUTE_WINDOW_SECONDS` | — |
| Requests per day | `10000` | `RATE_LIMIT_CREDENTIAL_PER_DAY` | `rateLimitPerDay` |
| Length of the day window | `86400` s | `RATE_LIMIT_CREDENTIAL_DAY_WINDOW_SECONDS` | — |

Overrides are set when the key is created (`POST /developer/api-keys`), copied to
the replacement on rotation, and cached in Redis for
`RATE_LIMIT_CREDENTIAL_QUOTA_CACHE_SECONDS` (default `60`) so a request that
carries only a credential id does not need a database read. A missing or
malformed override keeps the configured default.

### Counting

The check is a single Lua script
(`src/common/throttler/scripts/credential-rate-limit.lua.ts`) executed with
`EVAL`, so pruning old requests, checking both budgets and recording a request
is atomic: 50 concurrent requests against a budget of 10 let exactly 10
through, on any number of replicas.

- The clock is read with Redis `TIME` inside the script, so app-server clock
  skew cannot move a window.
- Redis sorted sets retain the timestamps of accepted requests; entries older
  than each window are pruned on the next request.
- Each sorted set expires after its window, and both request logs live in Redis,
  so an API or replica restart does not reset anyone's budget.

### Responses

Every response carries the quota of the window **closest to exhaustion**
(measured as the fraction of its budget still available):

- `X-RateLimit-Limit` — budget of that window,
- `X-RateLimit-Remaining` — requests left in it,
- `X-RateLimit-Reset` — Unix seconds when the oldest counted request in that
  window expires and frees capacity.

Exceeding either window answers **HTTP 429** (`RATE_LIMITED`) with the standard
problem-details body (`details.limit`, `details.retryAfterSeconds`,
`details.resetAt`) and a `Retry-After` header holding the seconds until a retry
could succeed — the latest reset of the exhausted windows, so a spent day
budget is not advertised as retryable in a minute. All four headers are exposed
to browser clients through CORS.

### Exemptions and failure policy

Health, readiness and the Prometheus scrape endpoint are exempt through
`@SkipCredentialRateLimit()`: probes must answer even when their caller is out
of quota. A revoked or expired key is rejected by authentication with 401
**before** this guard runs, so it never consumes quota.

If Redis is not `ready` or the check fails, the guard **fails open**: the
request is allowed and a warning is logged. General traffic should not turn a
cache outage into an API outage; the credential-issuing routes keep their
stricter fail-closed policy in `SensitiveRateLimitGuard`.

## Sensitive routes

Credential and webhook-management routes carry a dedicated, per-route budget
on top of the tier throttlers, declared with `@SensitiveRateLimit(route)`:

```ts
@Post('login')
@SensitiveRateLimit('login') // also attaches SensitiveRateLimitGuard
login() {}
```

The guard is applied route by route, never globally, so normal agent traffic
and the health and readiness probes are never counted against it. Each request
is counted in a Redis sliding window keyed by
`rate-limit:sensitive:<route>:<caller>`, where the caller is the client IP for
the routes reached before authentication and the authenticated API key
(`apikey:<id>`) or user (`user:<id>`) otherwise.

| Route | Key | Default limit | Redis unavailable |
| --- | --- | --- | --- |
| `POST /auth/login` | client IP | 5 per 60 s | **fails closed**: 503 `RATE_LIMIT_UNAVAILABLE` |
| `POST /auth/refresh` | client IP | 30 per 60 s | **fails closed**: 503 `RATE_LIMIT_UNAVAILABLE` |
| `POST /developer/api-keys` | API key or user | 10 per hour | **fails closed**: 503 `RATE_LIMIT_UNAVAILABLE` |
| `POST /webhooks` | API key or user | 20 per hour | fails open, logs a warning |
| `POST /webhooks/:id/rotate-secret` | API key or user | 10 per hour | fails open, logs a warning |

The limits are configurable with the `RATE_LIMIT_<ROUTE>_MAX` and
`RATE_LIMIT_<ROUTE>_WINDOW_SECONDS` variables (see the table below). The failure
mode is not configurable: it is fixed per route in
`src/common/throttler/sensitive-route-policy.ts`. The routes that issue or
refresh credentials fail closed, because running them without a limit during an
outage would let an attacker guess passwords or mint keys without bound. The
webhook routes already require an authenticated organization member and are
low volume, so an outage of the cache should not block them. "Redis
unavailable" means the shared client is not `ready` or the check itself fails;
the guard never waits on a reconnecting client.

An exceeded limit answers **HTTP 429** (`RATE_LIMITED`) with `Retry-After` (the
seconds until the oldest counted request leaves the window), the
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers and
the standard problem-details body, whose `details` carry `limit`,
`windowSeconds` and `retryAfterSeconds`. Rejected requests are not counted, so a
client that keeps retrying regains capacity as soon as its oldest request ages
out.

API keys have no regeneration route today: a key is revoked and a new one is
created, so the `POST /developer/api-keys` limit also bounds key replacement.

## Sliding window limiter

`SlidingWindowThrottlerGuard` is the limiter used by the high-frequency
routes. The limit of a route is declared with the `@SlidingWindowLimit`
decorator:

```ts
@Post()
@UseGuards(SlidingWindowThrottlerGuard)
@SlidingWindowLimit(30, 60) // 30 requests per 60 seconds
create(...) {}
```

The window is a Redis sorted set per client and route:

- every request adds a member scored with its timestamp,
- members older than the window are pruned on the next request,
- the count is read *before* the new member is inserted, so exactly `limit`
  requests are accepted per window,
- the whole update runs inside a `MULTI`/`EXEC` transaction, so concurrent
  requests cannot slip past the limit.

### Bucketing

The client identity is resolved in this order:

1. the acting agent — the route parameter, body, query or `x-agent-id` header
   that names the agent (`agent:<agentId>`),
2. the authenticated API key (`key:<apiKeyId>`),
3. the authenticated organization (`org:<organizationId>`),
4. a hashed raw API key for unauthenticated but keyed requests,
5. the client IP, honouring `x-forwarded-for`.

Bucketing per agent keeps a single misbehaving agent from exhausting the
budget of the other agents of the same organization, while the global limiter
still caps the total traffic of the API key or the user.

### Responses

A request that exceeds the limit is rejected with:

- **HTTP 429** (`RATE_LIMITED`),
- a `Retry-After` header with the number of seconds until the next request is
  accepted — the moment the oldest request of the window leaves it,
- `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers on every response,
  successful ones included.

The body is the standard RFC 9457 problem details document, so clients can
switch on `error.code` like for every other failure.

If Redis is unreachable the limiter **fails open** (the request is allowed and
the failure is logged) so an outage of the cache cannot take the API down.

## Tiers and API key scopes

`AstroidThrottlerGuard` enforces one tier per request. The tier is normally
declared by the route with `@ThrottleTierDecorator('auth' | 'api' | 'agent' |
'webhook')` and defaults to `api`.

An API key additionally carries **permission scopes**, and those scopes select a
tier of their own. The effective tier is the **most restrictive** of the two —
the one with the smaller configured limit — so a key can never use its scopes
to escape a stricter route tier:

| Scope | Tier | Why |
| --- | --- | --- |
| `auth:*`, `session*`, `apikey*`, `credential*`, `token*` | `auth` | A key that can mint or rotate credentials is the most valuable one to protect. |
| `webhook*` | `webhook` | A key that can re-point a destination can redirect every event a tenant emits. |
| `agent*`, `transactions:execute`, `transactions:submit`, `transactions:sign` | `agent` | Autonomous-agent control traffic, which the platform expects to be high volume. |
| anything else (`transactions:read`, `wallets:read`, `*`, …) | — | The route-declared tier stays in force. |

The mapping lives in `src/common/throttler/api-key-scope-tier.ts` and applies to
the steady-state **and** the burst throttler of the selected tier. The counter
is keyed by the verified API key id (`apikey:<id>`), so one key can never
exhaust the budget of another.

### Per-key override

An API key may carry its own `rateLimitPerMinute` value, set when the key is
created (`POST /developer/api-keys`) and copied to a replacement on rotation.
It replaces the tier's steady-state budget for that key only; the burst
allowance and every other key are unchanged, and the value never leaves the
database — the Redis counter is still keyed by `apikey:<id>`. Null (the
default) keeps the tier limit.

The same value, together with `rateLimitPerDay`, also overrides the
[per-credential quota](#per-credential-quota) enforced by
`CredentialRateLimitGuard`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_MAX_REQUESTS` | `120` | Default limit for routes without an explicit `@SlidingWindowLimit`. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Default window length. |
| `THROTTLE_API_LIMIT` | `120` | Steady-state limit of the `api` tier. |
| `THROTTLE_API_BURST` | `10` | Burst limit of the `api` tier. |
| `THROTTLE_AUTH_LIMIT` | `10` | Steady-state limit of the `auth` tier. |
| `THROTTLE_AUTH_BURST` | `3` | Burst limit of the `auth` tier. |
| `THROTTLE_AGENT_LIMIT` | `300` | Steady-state limit of the `agent` tier. |
| `THROTTLE_WEBHOOK_LIMIT` | `30` | Steady-state limit of the `webhook` tier. |
| `THROTTLE_WEBHOOK_BURST` | `5` | Burst limit of the `webhook` tier. |
| `THROTTLE_TTL` | `60` | Window of the tier throttlers. |
| `RATE_LIMIT_CREDENTIAL_PER_MINUTE` | `120` | Default per-credential requests per minute. |
| `RATE_LIMIT_CREDENTIAL_MINUTE_WINDOW_SECONDS` | `60` | Length of the per-credential minute window. |
| `RATE_LIMIT_CREDENTIAL_PER_DAY` | `10000` | Default per-credential requests per day. |
| `RATE_LIMIT_CREDENTIAL_DAY_WINDOW_SECONDS` | `86400` | Length of the per-credential day window. |
| `RATE_LIMIT_CREDENTIAL_QUOTA_CACHE_SECONDS` | `60` | How long per-key quota overrides stay cached in Redis. |
| `PUBLIC_RATE_LIMIT_MAX_REQUESTS` | `60` | Limit of the public IP limiter. |
| `PUBLIC_RATE_LIMIT_WINDOW_SECONDS` | `60` | Window of the public IP limiter. |
| `RATE_LIMIT_LOGIN_MAX` / `RATE_LIMIT_LOGIN_WINDOW_SECONDS` | `5` / `60` | Login limit per client IP. |
| `RATE_LIMIT_REFRESH_MAX` / `RATE_LIMIT_REFRESH_WINDOW_SECONDS` | `30` / `60` | Token refresh limit per client IP. |
| `RATE_LIMIT_API_KEY_CREATE_MAX` / `RATE_LIMIT_API_KEY_CREATE_WINDOW_SECONDS` | `10` / `3600` | API-key creation limit per API key or user. |
| `RATE_LIMIT_WEBHOOK_CREATE_MAX` / `RATE_LIMIT_WEBHOOK_CREATE_WINDOW_SECONDS` | `20` / `3600` | Webhook creation limit per API key or user. |
| `RATE_LIMIT_WEBHOOK_ROTATE_MAX` / `RATE_LIMIT_WEBHOOK_ROTATE_WINDOW_SECONDS` | `10` / `3600` | Webhook secret rotation limit per API key or user. |

The limit of a single agent can be lowered further with the `rateLimit` entry
of its metadata (`{ "rateLimit": 5 }`); `AgentRateLimiterGuard` reads it and
caches it in Redis for five minutes.

## Testing

- `src/common/guards/sliding-window-throttler.guard.spec.ts` — normal
  requests, limit violations, the `Retry-After` value, per-agent bucketing and
  concurrent requests.
- `src/modules/agents/tests/agent-rate-limiter.spec.ts` — the per-agent
  limiter, including concurrent requests.
- `src/common/guards/agent-throttler.guard.spec.ts` — the tier routing and the
  agent-aware tracker.
- `src/common/guards/throttler.guard.spec.ts` — the tier routing, the API key
  scope tier and the rate-limit exhaustion of a scope-derived tier.
- `src/common/throttler/api-key-scope-tier.spec.ts` — the scope → tier table.
- `src/common/guards/sensitive-rate-limit.guard.spec.ts` — allowed and blocked
  requests, the window reset, per-route and per-caller budgets, both Redis
  failure modes, and which routes carry `@SensitiveRateLimit`.
- `src/common/guards/sensitive-route-rate-limit.http.spec.ts` — requests past
  the limit over HTTP (429, `Retry-After`, problem details) and the 503 and
  fail-open behaviour while Redis is down.
- `src/common/guards/credential-rate-limit.guard.spec.ts` — identity resolution,
  per-key overrides and their cache, the quota headers, both exhausted windows,
  the exemptions and the fail-open policy.
- `src/common/guards/credential-rate-limit.http.spec.ts` — the same contract over
  real HTTP, including the problem-details body, per-credential isolation, the
  readiness exemption and revoked keys.
- `src/common/throttler/credential-rate-limit.redis.integration.spec.ts` — runs
  against a real Redis when `REDIS_URL` is set: 50 concurrent requests against a
  budget of 10, rejected requests consuming nothing, counters surviving a client
  restart, the independent day window, rolling-window boundaries and expiry for
  a 30-day window.
