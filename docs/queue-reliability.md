# Queue Reliability

Queue registrations use `createQueueRegistrationOptions` from `src/queues/queue-policy.ts` unless a domain has an explicit override.

| Setting | Shared default | Webhook override | Transaction override |
| --- | --- | --- | --- |
| Attempts | 3 | 5 | 5 |
| Backoff | Exponential, 1 second base, 20% jitter | Exponential, 2 second base, 20% jitter | Exponential, 2 second base, 20% jitter |
| Completed retention | 1,000 jobs | 1,000 jobs | 1,000 jobs |
| Failed retention | 24 hours or 5,000 jobs | 24 hours or 5,000 jobs | 24 hours or 5,000 jobs |

`PermanentJobError` stops immediately. BullMQ unrecoverable errors and deterministic HTTP 4xx errors are also permanent, except 408, 425, and 429. Validation errors are permanent; unclassified errors, temporary network failures, and dependency errors remain retryable under the bounded defaults. Domain-specific overrides belong next to the queue registration and must use the typed options builder.

Terminal failures are observed by `QueueFailureListener` and include the queue, job type and ID, attempt count, safe organization/agent identifiers, and request ID when available. Failure reasons, stacks, and payload metadata pass through the shared redactor before logging, DLQ storage, or audit-event persistence.

## Transaction execution queue

`Queues.Transactions` runs with five attempts and a two-second exponential backoff base. The transaction worker classifies the failure with the shared worker wrapper:

- A transient error is rethrown, so BullMQ reschedules the job with backoff and jitter.
- A deterministic error (`PermanentJobError`) is marked unrecoverable and stops immediately.
- When the last attempt fails, the worker emits a `dead_letter.job_failed` domain event with the queue, job id, attempt count, failure reason and the organization/agent/transaction identifiers, and logs the failure at error level. The event is the ledger counterpart of the dead-letter queue entry, so a permanently failed transaction is visible to the operations tooling next to the retry history.
