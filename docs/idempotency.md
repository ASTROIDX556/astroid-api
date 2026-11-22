# Idempotency-Key Support

Mutating endpoints accept an optional `Idempotency-Key` header. The mechanism is
implemented once under `src/common/idempotency` and applied to endpoints with
the `@Idempotent()` decorator plus `@UseInterceptors(IdempotencyInterceptor)`.
It is currently applied to:

- `POST /transactions` (transaction creation)
- `POST /webhooks` (webhook subscription creation)

A request without the header behaves exactly as before.

## Semantics

| Situation | Result |
|---|---|
| No `Idempotency-Key` | Normal execution. |
| First request for a key | Executes normally; status, body and request id are stored. |
| Repeat with the same body after completion | Replays the original status, body and `X-Request-ID`. |
| Repeat with a different body | `422 Unprocessable Entity`. |
| Duplicate while the original is still running | `409 Conflict` with `Retry-After`. |
| Original failed (including a 5xx) | The reservation is released, so the client may retry. |
| Record older than the TTL | Treated as expired: removed and processed fresh. |

Keys are scoped by **authenticated principal and route**, so two users (or two
endpoints) may use the same opaque key independently.

## Storage

Two layers, each with a distinct job:

- **Redis** (`idempotency:lock:<principal>:<route>:<keyHash>`) is the
  short-lived in-progress lock. It makes concurrent duplicates fail fast and is
  released with a compare-and-delete script so a slow request cannot release
  another request's lock. If Redis is unavailable the durable layer still
  prevents two executions.
- **Prisma** (`idempotency_records`) stores the request hash, the completed
  response and the original request id. `(principalId, route, keyHash)` is
  unique. A `PROCESSING` row doubles as a durable in-progress marker if the
  Redis lock is lost.

The request hash is `sha256(stableStringify(body))`. Keys are sorted
recursively, so `{"a":1,"b":2}` and `{"b":2,"a":1}` hash identically while array
order is preserved.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `IDEMPOTENCY_KEY_TTL_HOURS` | `24` | How long a completed record remains replayable. |
| `IDEMPOTENCY_WAIT_TIMEOUT_MS` | `5000` | Upper bound used to size the in-progress lock. |
| `IDEMPOTENCY_POLL_INTERVAL_MS` | `100` | Derives the `Retry-After` hint for `409` responses. |

Expired rows are removed lazily when the same key is seen again; the
transaction idempotency cleanup job remains responsible for the older
`transaction_idempotency_records` table.

## Exclusions

Streaming responses and multipart/file-upload requests are excluded: their
bodies cannot be buffered for deterministic hashing and their responses cannot
be replayed safely. The interceptor bypasses them even when decorated. Do not
apply `@Idempotent()` to such routes.

## Backward compatibility

The header was already optional on `POST /transactions`; its documented
behaviour is unchanged, but a body mismatch now returns `422` instead of the
previous `409`, matching this contract. `POST /webhooks` gains the same optional
behaviour without changing its response shape (the signing secret returned once
is part of the replayed response).
