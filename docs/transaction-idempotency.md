# Transaction Submission Idempotency

`POST /transactions` optionally accepts an `Idempotency-Key` header. The value is
trimmed and must be 8–255 characters. The header name itself is configurable via
`IDEMPOTENCY_HEADER_NAME`. Requests without the header retain the existing
behavior exactly: no record is written and no extra latency is added.

## Key scope

A key is scoped to the **authenticated credential** and the **route** that
accepted it (`POST /transactions`). JWT users use `user:<id>` and API keys use
`apikey:<id>`, so a user and an API key may reuse the same key string. The
database enforces a unique constraint on `(scope, route, keyHash)`; the raw key
is never stored, only its SHA-256 digest.

## Fingerprint

The request fingerprint is a SHA-256 digest of the canonical JSON of the parsed
request body. Object keys are sorted recursively and the route's Zod schema is
applied before hashing, so defaults and equivalent amounts (`50.0` and
`50.0000000`) produce the same fingerprint.

## Behavior

| Situation | Result |
| --- | --- |
| First request with a key | A `PROCESSING` record is created before the governance pipeline runs; the response, status and request id are stored on success. |
| Same key and fingerprint, original completed | The original status, body and `requestId` are replayed with `Idempotency-Replayed: true` (and the legacy `Idempotent-Replay: true`); no second transaction or on-chain submission occurs. |
| Same key and fingerprint, original still processing | `409` with `IDEMPOTENCY_KEY_IN_FLIGHT` and a `Retry-After` hint. |
| Same key, different fingerprint | `422` with `IDEMPOTENCY_KEY_MISMATCH`. |
| Original fails before completion | The reservation is released so the client can retry the same key. |
| Record older than the TTL | The expired record is deleted and the request is processed fresh. |

## Concurrency

Reservation is a single `INSERT` guarded by the composite unique constraint, so
the database arbitrates duplicates across every API replica. A short-lived Redis
lock rejects in-flight duplicates fast when Redis is available; when it is not,
the unique constraint still guarantees exactly one execution.

Expired records are removed when a key is reused and by a repeatable BullMQ job
(`IdempotencyCleanupScheduler` / `IdempotencyCleanupWorker`) registered once via
`upsertJobScheduler`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `IDEMPOTENCY_HEADER_NAME` | `Idempotency-Key` | Header carrying the key on transaction creation. |
| `IDEMPOTENCY_KEY_TTL_HOURS` | `24` | How long a completed record stays replayable. |
| `IDEMPOTENCY_WAIT_TIMEOUT_MS` | `5000` | Bounds the in-progress lock and retry hint. |
| `IDEMPOTENCY_POLL_INTERVAL_MS` | `100` | Base for the `Retry-After` hint. |
