# Transaction Submission Idempotency

`POST /transactions` optionally accepts an `Idempotency-Key` header. Keys must
contain 1-128 ASCII letters, digits, dots, underscores, tildes, or hyphens.
Requests without the header retain the existing behavior.

Records are scoped to the authenticated principal and the `transactions.create`
operation. The database stores SHA-256 digests of the key and the canonical,
validated request payload, never the raw key. Payload object keys are sorted and
decimal amounts are normalized before hashing, so `50.0` and `50.0000000` are
the same payload.

## Behavior

| Situation | Result |
| --- | --- |
| First request with a key | The transaction is processed normally, then the key, request hash, response and transaction id are stored on a `COMPLETED` record. |
| Repeat with the same key and payload, original completed | The stored response is returned; no second transaction row is created and no second Stellar payment is submitted. |
| Repeat with the same key and payload, original still processing | The duplicate waits up to `IDEMPOTENCY_WAIT_TIMEOUT_MS`, polling every `IDEMPOTENCY_POLL_INTERVAL_MS`, then returns the stored result. Only one request ever executes. |
| Repeat with the same key but a different payload | HTTP `409` (`CONFLICT`) in the standard problem-details error envelope. |
| Repeat after the retention window | The expired record is ignored and deleted, and the request is processed as a fresh submission. |
| Original fails before a transaction is persisted | Its reservation is released so the client can retry the same key. |

The composite unique constraint on principal, operation, and key digest
arbitrates concurrent requests across API instances: exactly one request wins
the `PROCESSING` reservation, and every duplicate observes the same record.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `IDEMPOTENCY_KEY_TTL_HOURS` | `24` | How long a completed record stays replayable. |
| `IDEMPOTENCY_WAIT_TIMEOUT_MS` | `5000` | How long an in-flight duplicate waits for the original result before returning `409`. `0` returns the conflict immediately. |
| `IDEMPOTENCY_POLL_INTERVAL_MS` | `100` | Poll interval used while waiting for the in-flight original. |

## Cleanup

Completed records expire after the configured retention window. An hourly
scheduled job (`TransactionIdempotencyCleanupService`) deletes expired rows, and
an expired record is also removed when its key is reused. The table therefore
stays bounded while clients can still retry delayed requests during the window.
