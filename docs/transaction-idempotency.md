# Transaction Submission Idempotency

`POST /transactions` optionally accepts an `Idempotency-Key` header. Keys must
contain 1-128 ASCII letters, digits, dots, underscores, tildes, or hyphens.
Requests without the header retain the existing behavior.

Records are scoped to the authenticated principal and the `transactions.create`
operation. The database stores SHA-256 digests of the key and the canonical,
validated request payload, never the raw key. Payload object keys are sorted and
decimal amounts are normalized before hashing.

A matching completed request returns its stored result without creating a
transaction or submitting another Stellar payment. Reusing a key with a
different payload returns HTTP 409. A matching request that arrives while the
first is processing also returns HTTP 409 and can be retried after completion.
The composite unique constraint on principal, operation, and key digest
arbitrates concurrent requests across API instances. If processing fails before
a transaction is persisted, its reservation is removed so the client can retry.

Completed records expire 24 hours after completion. Expired records are removed
hourly, and an expired record is also removed when its key is reused. The
retention window is therefore bounded while allowing clients to retry delayed
requests during that period.