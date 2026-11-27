# Health probes

Two infrastructure endpoints let orchestrators and load balancers tell "the
process is alive" apart from "its dependencies can serve traffic".

> **Infrastructure endpoints, not public API.** The probes live at fixed paths
> **outside** the versioned API prefix (`/health/live`, not `/api/v1/health/live`)
> so probe configuration never changes with the API version. They need no
> credentials, are never rate limited and write no audit rows. They are not part
> of the public API contract and may gain fields; do not build product features
> on them.

| Probe | Path | Touches dependencies | Success | Failure |
| ----- | ---- | -------------------- | ------- | ------- |
| Liveness | `GET /health/live` | No | `200` while the process can answer HTTP | n/a |
| Readiness | `GET /health/ready` | PostgreSQL (`SELECT 1`), Redis (`PING`), the BullMQ queue connection (`PING`), the Soroban RPC (`getHealth`) | `200` when every required dependency is up | `503` when any required dependency is down or times out |

Use liveness for "restart this container" decisions and readiness for "send
traffic to this instance" decisions. A dependency outage must only ever fail
readiness, never liveness.

## Response

Both probes answer in the standard envelope (`{ success, data, meta, requestId }`).
`success` is `false` on a `503`. The stable, machine-readable part is
`data.status` plus the `data.checks` list:

```json
{
  "success": false,
  "data": {
    "status": "down",
    "timestamp": "2026-01-15T10:30:00.000Z",
    "checks": [
      { "name": "database", "status": "up", "latencyMs": 3 },
      { "name": "cache", "status": "down", "latencyMs": 1000, "error": "timeout" }
    ],
    "services": {
      "database": { "status": "up", "latencyMs": 3, "timestamp": "2026-01-15T10:30:00.000Z" },
      "cache": { "status": "down", "latencyMs": 1000, "timestamp": "2026-01-15T10:30:00.000Z", "error": "timeout" }
    }
  },
  "meta": {},
  "requestId": "req-123"
}
```

- `checks[].error` is only ever `timeout` or `unavailable`. Driver messages,
  hosts, connection strings and stack traces are **never** returned; they are
  logged server-side by `ReadinessRunner` and the indicators.
- `services` (keyed by dependency name) is kept for existing clients; prefer
  `checks`.

## Timeouts and caching

Each check is bounded by a hard timeout, so a hung dependency cannot hang the
probe. Checks run in parallel.

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `HEALTH_CHECK_TIMEOUT_MS` | `1000` | Per-check timeout, `50`-`10000`. Invalid values fall back to the default. |
| `HEALTH_READINESS_CACHE_TTL_MS` | `0` (off) | Reuse a readiness result for this long, `0`-`10000`. Concurrent requests share one run. `1000`-`2000` is reasonable if probes poll aggressively. |

## Adding a dependency

Readiness is driven by a list of named checks in `HealthController`
(`readinessChecks`). Append `{ name, run: (timeoutMs) => Promise<{ status, latencyMs?, error? }> }`
to add one; set `required: false` to report a dependency without letting it fail
readiness. `ReadinessRunner` (`src/modules/health/readiness-runner.ts`) handles
timeouts, error sanitising and caching.

## Other diagnostics

`GET /api/v1/health`, `/liveness`, `/readiness`, `/database`, `/redis` and
`/stellar` are richer diagnostics under the versioned prefix. They can include
failure detail and are intended for operators, not for orchestrator probes.
