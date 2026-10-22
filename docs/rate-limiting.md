# Rate Limiting

The API protects itself with three independent rate limiters. Every limiter
keeps its counters in Redis, so the limits hold across all replicas of the
service.

| Limiter | Scope | Where it is applied |
| --- | --- | --- |
| `AstroidThrottlerGuard` | Per API key → per user → per organization → per IP | Every route (global guard) |
| `AgentThrottlerGuard` | Per acting agent → per organization → per API key → per IP | Agent-facing controllers |
| `SlidingWindowThrottlerGuard` | Per acting agent → per API key → per organization → per IP | Transaction submission, agent commands, webhook ingress |
| `PublicRateLimiterGuard` | Per IP (and API key when present) | Unauthenticated routes |
| `AgentRateLimiterGuard` | Per agent, with the limit taken from the agent metadata | `POST /agents/:id/execute` |

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

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_MAX_REQUESTS` | `120` | Default limit for routes without an explicit `@SlidingWindowLimit`. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Default window length. |
| `THROTTLE_API_LIMIT` | `120` | Steady-state limit of the `api` tier. |
| `THROTTLE_API_BURST_LIMIT` | `10` | Burst limit of the `api` tier. |
| `THROTTLE_AUTH_LIMIT` | `10` | Steady-state limit of the `auth` tier. |
| `THROTTLE_AUTH_BURST_LIMIT` | `3` | Burst limit of the `auth` tier. |
| `THROTTLE_AGENT_LIMIT` | `300` | Steady-state limit of the `agent` tier. |
| `THROTTLE_TTL` | `60` | Window of the tier throttlers. |
| `PUBLIC_RATE_LIMIT_MAX_REQUESTS` | `60` | Limit of the public IP limiter. |
| `PUBLIC_RATE_LIMIT_WINDOW_SECONDS` | `60` | Window of the public IP limiter. |

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
