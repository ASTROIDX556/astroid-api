# Transaction Submission Idempotency

`POST /transactions` optionally accepts an `Idempotency-Key` header. Keys must
contain 1-128 ASCII letters, digits, dots, underscores, tildes, or hyphens.
Requests without the header retain the existing behavior exactly: no record is
written and no extra latency is added.

## Key scope

A key is scoped to the **authenticated principal** and the **route** that
accepted it (for transaction submission, `POST /transactions`). Two principals
may use the same key independently, and the same key may also be used on a
different endpoint. The scope is enforced by a database unique constraint on
`(principalId, route, keyHash)`; the raw key is never stored, only its SHA-256
digest.

## Fingerprint

The request fingerprint is a SHA-256 digest of the canonical JSON of the
normalized request body plus any route parameters. Object keys are sorted and
decimal amounts are normalized (`50.0` and `50.0000000` are the same payload),
so semantically identical retries replay instead of creating a second
transaction.

## Behavior

| Situation | Result |
| --- | --- |
| First request with a key | The idempotency record is created **before** any work (and before any queue enqueue). The transaction is processed normally, then the record is completed with the response, status and request id. |
| Repeat with the same key and fingerprint, original completed | The original response is returned with its original status code (201), body and `requestId`; no second transaction row is created and no second Stellar payment is submitted. |
| Repeat with the same key and fingerprint, original still processing | The duplicate waits up to `IDEMPOTENCY_WAIT_TIMEOUT_MS`, polling every `IDEMPOTENCY_POLL_INTERVAL_MS`, then returns the stored result. Only one request ever executes. |
| Repeat with the same key but a different fingerprint | HTTP `409` (`CONFLICT`) in the standard problem-details error envelope. |
| Repeat after the retention window | The expired record is ignored and deleted, and the request is processed as a fresh submission. |
| Original fails before a transaction is persisted | Its reservation is released so the client can retry the same key. |

## Concurrency

Reservation is a single `INSERT` guarded by the composite unique constraint, so
the database arbitrates concurrent duplicates across every API replica: exactly
one request wins the `PROCESSING` record and every duplicate observes it.
`IdempotencyService.enqueueOnce()` applies the same guarantee to queued work: the
record is written first and `enqueue` is called at most once for a key, even
under concurrent requests.

## Asynchronous completion and failure

When a transaction is executed asynchronously, the worker finalizes its record:

- a terminal success calls `IdempotencyService.finalizeTransaction()`, storing
  the response, status and request id on the `PROCESSING` record so later
  duplicates replay it;
- a terminal failure calls `IdempotencyService.failTransaction()`, marking the
  record `FAILED`. A `FAILED` record is reusable: the next request with that key
  is processed as a fresh submission instead of waiting forever.

Expired records are also deleted when the key is reused, and an hourly scheduled
job (`TransactionIdempotencyCleanupService`) bounds the table.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `IDEMPOTENCY_KEY_TTL_HOURS` | `24` | How long a completed record stays replayable. |
| `IDEMPOTENCY_WAIT_TIMEOUT_MS` | `5000` | How long an in-flight duplicate waits for the original result before returning `409`. `0` returns the conflict immediately. |
| `IDEMPOTENCY_POLL_INTERVAL_MS` | `100` | Poll interval used while waiting for the in-flight original. |
