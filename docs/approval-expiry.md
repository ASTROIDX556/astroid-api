# Approval expiry

Approval proposals (`Proposal`) can carry an `expiresAt`. Once that moment has
passed the proposal can no longer be decided; it becomes **`EXPIRED`**, a
terminal state that is part of the public proposal status enum:

```
DRAFT · PENDING · APPROVED · REJECTED · EXPIRED · EXECUTED · CANCELLED
```

`EXPIRED` never goes back to `PENDING`, and an expired proposal can never also
be `APPROVED`. The status enum already existed, so no migration is required.

## The sweep (janitor)

- **Job name:** `approval-expiry`
- **Queue:** `approvals` (`Queues.Approvals`)
- **Cadence:** every **5 minutes** (`APPROVAL_EXPIRY_INTERVAL_MS`, a BullMQ
  repeatable job registered by `ApprovalExpiryScheduler` on application start)
- **Worker:** `ApprovalExpiryWorker` calls `ApprovalService.expireStale()`; the
  sweep logic lives in the service, the worker only invokes it.
- **Batch size:** at most 500 proposals per run (`APPROVAL_EXPIRY_BATCH_SIZE`);
  a second tick picks up the remainder.
- **Events:** one `proposal.expired` domain event per transition
  (`{ proposalId, transactionId }`), consumed by notifications/audit/webhooks
  like any other proposal event.
- **Logging:** the number of rows transitioned is logged at `info`.

Because the job is a BullMQ repeatable job, every replica may register it —
BullMQ deduplicates the repeat key, and the sweep itself is idempotent.

## Race safety

The sweep reads candidates (status `PENDING`, `expiresAt <= now`) only as a
hint. Each transition is a conditional single-row update:

```ts
updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED' } })
```

The returned `count` decides whether the row was actually expired, so:

- a proposal approved (or rejected) at the same moment is **skipped** and emits
  no expiry event;
- an already expired proposal is never expired twice.

The decision path mirrors the rule: `ApprovalService.decide()` moves a proposal
out of `PENDING` with the same conditional `updateMany`. When that update changes
no row — because the sweeper won the race — the decision fails with
`409 PROPOSAL_NOT_PENDING` and the transaction is never executed.

## The guard (409)

The sweeper is a janitor, not the guard. `POST /api/v1/proposals/:id/decision`,
`/approve` and `/reject` check `expiresAt` themselves and answer:

```
409 Conflict
code: PROPOSAL_EXPIRED
```

even if the sweep has not run yet (the call performs the expiry transition
first when it is the one that observes it).

## Downstream execution

`TransactionService.execute()` checks the linked proposal **status**, not just
the presence of an approval row. A transaction whose proposal is `EXPIRED` (or
`DRAFT`, `PENDING`, `REJECTED`, `CANCELLED`) is rejected with
`409 PROPOSAL_EXPIRED` / `409 PROPOSAL_NOT_PENDING` before any status write or
on-chain submission. Only `APPROVED` passes.

The proposal's transaction row is left as `PENDING` by the sweep; it can never
be submitted because of the guard above.

## Clock

Expiry is computed consistently from the **application clock**: `expireStale()`
defaults to `new Date()` and the decision path compares against `Date.now()`.
Clock skew between replicas can at worst delay a sweep (or make two replicas
race for the same row), which the conditional update resolves deterministically.
