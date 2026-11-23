# Idempotency-Key Support

Create endpoints accept an optional idempotency header (default
`Idempotency-Key`, configurable with `IDEMPOTENCY_HEADER_NAME`). The value is
trimmed and must be 8–255 characters. Routes that do not opt in ignore the header.

The mechanism lives under `src/common/idempotency`; a handler opts in with
`@Idempotent()` and `@UseInterceptors(IdempotencyInterceptor)`. It is enabled on
`POST /transactions`, `POST /budgets/:id/allocate` and `POST /webhooks`.

## Semantics

| Situation | Result |
|---|---|
| No header | Normal execution. |
| First request for a key | Executes normally; status, body and request id are stored. |
| Repeat with the same body after completion | Replays the original status, body and `X-Request-ID`, plus `Idempotency-Replayed: true`. |
| Repeat with a different body | `422` with `IDEMPOTENCY_KEY_MISMATCH`. |
| Duplicate while the original is still running | `409` with `IDEMPOTENCY_KEY_IN_FLIGHT` and `Retry-After`. |
| Original failed (including a 5xx) | The reservation is released, so the client may retry. |
| Record older than the TTL | Treated as expired: removed and processed fresh. |

Keys are scoped by **credential** (`user:<id>` or `apikey:<id>`) and route, so
two credentials may use the same opaque key independently.

## Storage

- **Redis** holds a short-lived in-progress lock and is released with a
  compare-and-delete script. The durable layer still arbitrates if Redis is
  unavailable.
- **Prisma** (`idempotency_records`) stores the request hash, completed response
  and original request id. `(scope, route, keyHash)` is unique and `expiresAt`
  is indexed.

The fingerprint is `sha256(canonicalJson(parsedBody))`: object keys are sorted at
every depth while array order is preserved. The route's Zod schema is applied
first so equivalent payloads hash identically.

## Configuration and cleanup

See [configuration.md](configuration.md) for `IDEMPOTENCY_HEADER_NAME`,
`IDEMPOTENCY_KEY_TTL_HOURS` (default 24 hours), `IDEMPOTENCY_WAIT_TIMEOUT_MS`
and `IDEMPOTENCY_POLL_INTERVAL_MS`. A repeatable BullMQ job prunes expired rows
hourly.

## Exclusions

Streaming responses and multipart/file-upload requests are excluded: their
bodies cannot be buffered for deterministic hashing and their responses cannot
be replayed safely.
