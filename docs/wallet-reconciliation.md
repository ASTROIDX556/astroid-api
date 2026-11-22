# Scheduled Stellar Wallet Reconciliation

Active wallets are periodically reconciled against the Stellar network so the
stored balance snapshot never drifts silently from the chain.

## Queue and worker

| Component | Location |
| --- | --- |
| Queue name | `wallet-reconciliation` (`Queues.WalletReconciliation`) |
| Processor | `src/workers/wallet-reconciliation.worker.ts` |
| Repeatable registration | `src/workers/wallet-reconciliation.scheduler.ts` |
| Domain logic | `src/modules/wallets/services/wallet-reconciliation.service.ts` |
| Module wiring | `src/modules/wallets/wallet-reconciliation.module.ts` |

The repeatable job is registered with `upsertJobScheduler` under the stable id
`wallet-reconciliation`. Re-registering on every boot (or from several replicas)
updates the same schedule instead of stacking duplicate repeatable jobs.

`WalletReconciliationScheduler.trigger()` enqueues a one-off run on demand. The
API process registers the schedule in the background, so an unavailable Redis
never blocks or aborts application startup.

## Processing

1. `WalletRepository.findActiveForReconciliation()` selects **ACTIVE** wallets
   only — archived, frozen, paused and soft-deleted wallets are skipped. The
   existing `wallets.status` index serves the predicate; no extra index is
   needed.
2. Wallets are processed with bounded concurrency
   (`WALLET_RECONCILIATION_CONCURRENCY`, default `5`) by
   `runWithConcurrency`.
3. The native (XLM) balance is fetched through the global `StellarService`,
   which wraps the mockable `StellarClient` integration and the Horizon circuit
   breaker. Wallet business logic never talks to Horizon directly.
4. **Only on a successful fetch** the snapshot is written:
   `balance` and `lastSyncedAt` are updated together.
5. A failed fetch logs `Wallet reconciliation failed for wallet <id>: <reason>`
   and leaves the stored balance and `lastSyncedAt` untouched. One failing
   wallet never interrupts the rest of the run.

## Drift events

When the difference between the stored snapshot and the freshly fetched balance
exceeds `WALLET_BALANCE_DRIFT_THRESHOLD`, one `wallet.balance_drift_detected`
domain event is emitted per wallet per run through the shared event bus:

```json
{
  "walletId": "018f...",
  "previousBalance": "10.0000000",
  "newBalance": "25.5000000",
  "reconciledAt": "2026-11-22T09:00:00.000Z"
}
```

A wallet with no previous snapshot (first successful sync) never emits a drift
event, and neither does a failed upstream request.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `WALLET_RECONCILIATION_ENABLED` | `true` | Register the repeatable job at boot. |
| `WALLET_RECONCILIATION_INTERVAL_MINUTES` | `15` | Interval between runs. |
| `WALLET_RECONCILIATION_CONCURRENCY` | `5` | Wallets reconciled in parallel. |
| `WALLET_BALANCE_DRIFT_THRESHOLD` | `0.0000001` | XLM delta above which a drift event is emitted. |

The Stellar network and Horizon endpoint come from the existing
`STELLAR_NETWORK` / `STELLAR_HORIZON_URL` variables.
