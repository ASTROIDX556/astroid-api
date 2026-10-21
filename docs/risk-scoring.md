# Risk Scoring

Every payment an agent initiates is scored before it can move funds. The score
is a composite between **0 and 100** built from independent heuristics; the
higher the score, the more likely the transaction needs a human to look at it.

The implementation lives in `src/modules/risk/`:

| File | Responsibility |
| --- | --- |
| `risk.engine.ts` | Pure scorer: turns the risk factors into a score, a band and the factor breakdown. |
| `rules/*.ts` | One pluggable rule per heuristic. A rule is a pure function of the factors and the config. |
| `risk-aggregator.service.ts` | Gathers the raw signals (velocity, destination reputation, amount baseline), scores them, persists the assessment and emits the risk events. |
| `risk.repository.ts` | Persistence for the assessments and the queries that derive the signals. |
| `risk.service.ts` | Read-only facade for the ad-hoc assessment endpoint and the compliance reporting. |

## Signals

The aggregator derives three signals from the transaction history. They are
gathered in parallel and fed into the engine as risk factors.

| Signal | Source | Factor |
| --- | --- | --- |
| **Velocity** — how much the sending wallet moved recently | Transactions of the wallet in the trailing 24 hours | `velocity` |
| **Destination reputation** — how reliable the destination has been | Prior payments of the organization to the address | `destinationReputation`, `unknownRecipient` |
| **Amount anomaly** — how far the amount strays from the wallet's own average | Average amount of the wallet in the trailing 90 days | `amountAnomaly`, `amount` |

Supporting heuristics: `walletAge` (new wallets are riskier),
`policyViolations` and `suspiciousTiming` (transfers during the configured
overnight window).

## Weights

The weights always sum to 100, so a fully saturated assessment reaches exactly
100.

| Factor | Weight | Meaning |
| --- | ---: | --- |
| `amount` | 30 | Absolute size of the transfer, saturating at `amountSaturation` (default 10 000). |
| `amountAnomaly` | 10 | Transfer size relative to the wallet's historical average, saturating at `amountAnomalySaturation` times the average (default 5). |
| `unknownRecipient` | 15 | The organization never paid this destination before. |
| `destinationReputation` | 10 | Failure rate and depth of the payment history with the destination. |
| `velocity` | 20 | Transaction count **and** value moved in the velocity window. |
| `walletAge` | 10 | Age of the sending wallet, saturating at `walletSeasonedDays` (default 90). |
| `policyViolations` | 5 | Policy violations detected for the intent. |
| `suspiciousTiming` | 5 | Transfer attempted during the suspicious hours (default 00:00–05:00 UTC). |

All weights and saturation points are overridable per organization or agent
through `RiskConfig` (`src/modules/risk/risk.types.ts`).

## Bands and thresholds

| Band | Score | Effect |
| --- | --- | --- |
| `LOW` | 0–20 | The transaction may execute automatically. |
| `MEDIUM` | 21–50 | The transaction may execute automatically. |
| `HIGH` | 51–80 | Human review: the transaction is queued for approval. |
| `CRITICAL` | 81–100 | Human review, dual approval, never auto-executed. |

Two explicit thresholds drive the routing:

- `reviewThreshold` (default **51**) — at or above it the transaction
  `requiresApproval` and a `Proposal` is created instead of executing.
- `blockThreshold` (default **81**) — at or above it the transaction can never
  auto-execute (`canAutoExecute` is false).

Both default to the boundaries of the `HIGH` and `CRITICAL` bands, so the band
and the thresholds always agree.

## Lifecycle

```
POST /transactions
   │
   ├─ policies           → blocked transactions never reach the risk stage
   ├─ risk.assess()      → composite score + signals (read-only)
   ├─ transaction row    → riskScore, riskBand, requiresApproval
   ├─ risk.record()      → RiskAssessment row linked to the transaction
   │                      + risk.evaluated event
   │                      + risk.alert event (high risk only)
   └─ approval branch    → Proposal (PENDING) for high risk, otherwise execute
```

The assessment is scored before the transaction row exists (the score decides
whether a human approval is needed) and persisted immediately after the row was
created, so the stored assessment is always the one the decision was based on.

## Events

| Event | Payload | Consumers |
| --- | --- | --- |
| `risk.evaluated` | `transactionId`, `score`, `band`, `factors`, `canAutoExecute`, `requiresApproval` | Audit trail, analytics, webhooks |
| `risk.alert` | `transactionId`, `score`, `band`, `requiresApproval` | Notification listener → `RISK_ALERT` notifications for the organization's members |

Both events are written to the append-only `domain_events` ledger, so the
assessment is part of the audit trail.

## Persistence

Every scored transaction gets one `risk_assessments` row (unique per
transaction) holding the score, the band, the factor breakdown and the
`canAutoExecute` flag. Re-assessing a transaction refreshes the existing row.

## Testing

- `src/modules/risk/risk.engine.spec.ts` — scoring rules and thresholds.
- `src/modules/risk/risk-aggregator.service.spec.ts` — signal gathering,
  composite scoring, threshold boundaries, persistence and event emission.
- `src/modules/risk/risk.repository.spec.ts` — persistence and signal queries.
- `src/modules/transactions/tests/transaction.service.spec.ts` — the
  high-risk transaction is routed into the approval workflow instead of
  executing.
