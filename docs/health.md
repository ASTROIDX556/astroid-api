# Health probes

Two probes for orchestrators and load balancers. They are public (no token),
exempt from both rate limiters (the throttler tiers and the per-IP limiter that
guards every `@Public()` route) and from the audit trail, and are served
**outside** the global API prefix so their paths do not change with the API
version.

| Route               | Purpose   | Checks                                                  | Success | Failure |
| ------------------- | --------- | ------------------------------------------------------- | ------- | ------- |
| `GET /health/live`  | Liveness  | None. Answers whenever the process can serve HTTP.      | `200`   | n/a     |
| `GET /health/ready` | Readiness | Database, Redis cache, the BullMQ queue connection and the Soroban RPC. | `200` | `503` |

Use `live` as the liveness probe and `ready` as the readiness probe. A dependency
outage must never fail liveness, or the orchestrator restarts a healthy process.

## Response

Both answer in the standard `{ success, data, meta, requestId }` envelope.
Readiness replies `503` with `success: false` and the same `data`, so a client
reads one shape whatever the outcome.

```json
{
  "success": false,
  "data": {
    "status": "down",
    "timestamp": "2026-11-21T12:00:00.000Z",
    "services": {
      "database": { "status": "up", "latencyMs": 3, "timestamp": "..." },
      "cache": { "status": "down", "latencyMs": 2000, "timestamp": "...", "error": "timeout" },
      "queue": { "status": "up", "latencyMs": 1, "timestamp": "..." },
      "soroban": { "status": "up", "latencyMs": 40, "timestamp": "..." }
    }
  },
  "meta": {},
  "requestId": "..."
}
```

`data.status` is `up` only when every service is `up`; otherwise the probe answers
`503`.

## How each dependency is probed

| Service    | Probe                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `database` | `SELECT 1` through the shared `PrismaService`.                                                 |
| `cache`    | `PING` on the application's shared Redis client.                                               |
| `queue`    | `PING` on the connection of the registered BullMQ dead-letter queue, which every worker uses. |
| `soroban`  | A bounded Soroban RPC `getHealth` call on the configured `SOROBAN_RPC_URL`.          |

The queue probe reuses the connection the queue already holds, so it does not open
a new Redis connection per request, and it reports the state of the connection
jobs are enqueued through.

The `soroban` probe reuses the same configuration and request path as the
`/health/stellar` diagnostic route but checks **only** the Soroban RPC: Horizon
is not probed by readiness, so a Horizon outage cannot take an otherwise
healthy instance out of rotation. A `getHealth` answer other than `healthy`, a
non-2xx response, a DNS/transport error or an exhausted probe budget all count
as a failure and make the instance not ready.

Every probe is bounded by a **2 second** timeout, so a hung dependency fails the
probe instead of holding the request open. The probes run in parallel.

## What a failure looks like

The probe is unauthenticated, so a failing service reports a coarse reason only:
`timeout` (the check hit its timeout) or `unavailable` (anything else). The
driver message, which can name hosts, ports or connection strings, stays in the
server log.

## Diagnostic routes

Under the API prefix there are richer, also public, routes: `/health`,
`/health/readiness`, `/health/database`, `/health/redis` and `/health/stellar`.
`readiness` additionally reports the Stellar endpoints and pending migrations
(set `HEALTH_CHECK_MIGRATIONS_ENABLED=false` to skip the migration check). They
are meant for people and monitoring tools, not for orchestrator probes.

## Kubernetes example

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  timeoutSeconds: 3
```
