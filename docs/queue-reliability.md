# Queue Reliability

Queue registrations use `createQueueRegistrationOptions` from `src/queues/queue-policy.ts` unless a domain has an explicit override.

| Setting | Shared default | Webhook override |
| --- | --- | --- |
| Attempts | 3 | 5 (`WEBHOOK_MAX_ATTEMPTS`) |
| Backoff | Exponential, 1 second base | Custom strategy: exponential, 2 second base, 20% jitter, capped at 60 seconds (`WEBHOOK_BACKOFF_MAX_DELAY_MS`) |
| Completed retention | 1,000 jobs | 1,000 jobs |
| Failed retention | 24 hours or 5,000 jobs | 24 hours or 5,000 jobs |
| Setting | Shared default | Webhook override | Transaction override |
| --- | --- | --- | --- |
| Attempts | 3 | 5 | 5 |
| Backoff | Exponential, 1 second base, 20% jitter | Exponential, 2 second base, 20% jitter | Exponential, 2 second base, 20% jitter |
| Completed retention | 1,000 jobs | 1,000 jobs | 1,000 jobs |
| Failed retention | 24 hours or 5,000 jobs | 24 hours or 5,000 jobs | 24 hours or 5,000 jobs |

`PermanentJobError` stops immediately. BullMQ unrecoverable errors and deterministic HTTP 4xx errors are also permanent, except 408, 425, and 429. Validation errors are permanent; unclassified errors, temporary network failures, and dependency errors remain retryable under the bounded defaults. Domain-specific overrides belong next to the queue registration and must use the typed options builder.

Terminal failures are observed by `QueueFailureListener` and include the queue, job type and ID, attempt count, safe organization/agent identifiers, and request ID when available. Failure reasons, stacks, and payload metadata pass through the shared redactor before logging, DLQ storage, or audit-event persistence.

## Webhook retry backoff

The webhook queue registers a jittered exponential backoff strategy
(`createJitteredBackoffStrategy`). The delay of an attempt is calculated from
the attempt number:

```
delay = min(baseDelay * 2^(attempt - 1) + random(0, baseDelay * 0.2 * attempt), maxDelay)
```

The cap applies to the **total** delay (exponential part plus jitter), so a
long outage never schedules a retry further away than the configured ceiling.
The formula lives in `src/utils/backoff.util.ts` and is used by the queue
registration, so the worker and the delivery log always agree on the delay
(`webhookRetryDelayMs` reports exactly the delay BullMQ will schedule).

> The webhook queue selects the **`custom`** backoff type on purpose. BullMQ
> prefers its built-in `fixed` and `exponential` strategies over a registered
> custom strategy, so only the `custom` type actually applies the jitter and
> the maximum delay. The attempt number is 1-based — the same argument BullMQ
> hands to the strategy — so the first retry waits exactly the base delay,
> like BullMQ's built-in exponential backoff.

## Webhook circuit breaker

A subscriber that keeps failing must not be hammered. Every webhook endpoint
therefore has its own circuit, persisted in `webhook_circuit_states`:

| State | Behaviour |
| --- | --- |
| `CLOSED` | Deliveries are attempted normally. Every failed attempt increments the consecutive failure counter. |
| `OPEN` | The endpoint reached `WEBHOOK_CIRCUIT_FAILURE_THRESHOLD` consecutive failures. Deliveries are **not** attempted: the job is moved back into BullMQ's delayed set, which does not consume an attempt, and it is retried when the cooldown ends. |
| `HALF_OPEN` | The cooldown elapsed. A single probe delivery is allowed and holds a probe lease, so a second delivery waits instead of probing again. A successful probe closes the circuit and resets the counter; a failed probe opens it again for another cooldown. A lease that expires means the probe was lost, and a new one is allowed. |

The state lives in PostgreSQL, so it survives a worker restart and is shared by
every worker of a multi-instance deployment. The transitions are written with
conditional updates: a concurrent burst of failures opens the circuit exactly
once and never extends a cooldown that is already running. A per-endpoint
Redis lock (`RedisLock`) serialises the transitions on top of that, and the
circuit keeps working — with the database's compare-and-set guarantees alone —
when Redis is unavailable.

The breaker is enabled by `WEBHOOK_CIRCUIT_ENABLED` and reports its state
through two domain events:

| Event | Meaning |
| --- | --- |
| `webhook.circuit_opened` | The endpoint's circuit opened: deliveries are paused for the cooldown. This is the **temporary** state. |
| `webhook.circuit_closed` | A probe delivery succeeded: deliveries resume. |
| `webhook.delivery_failed` | A delivery reached its **terminal** state (retries exhausted or a permanent error). The compliance record of a terminal failure is the audit entry written by `WebhookAuditService`. |

Every failed attempt is also written to the delivery log with structured
metadata: `failureCategory` (`transient`, `permanent`, `timeout`,
`circuit-open`), `failureCode` (`HTTP_503`, `TIMEOUT`, `DESTINATION_REJECTED`,
…), `lastAttemptAt` and `nextRetryAt`.
## Transaction execution queue

`Queues.Transactions` runs with five attempts and a two-second exponential backoff base. The transaction worker classifies the failure with the shared worker wrapper:

- A transient error is rethrown, so BullMQ reschedules the job with backoff and jitter.
- A deterministic error (`PermanentJobError`) is marked unrecoverable and stops immediately.
- When the last attempt fails, the worker emits a `dead_letter.job_failed` domain event with the queue, job id, attempt count, failure reason and the organization/agent/transaction identifiers, and logs the failure at error level. The event is the ledger counterpart of the dead-letter queue entry, so a permanently failed transaction is visible to the operations tooling next to the retry history.
