# Budget Threshold Alerts

## Configuration

Global thresholds are percentages of a budget's limit:

```
BUDGET_ALERT_THRESHOLDS=80,100
```

Defaults are `80` and `100`. Entries are parsed as integers between 1 and 100,
sorted and de-duplicated; at least one valid threshold is required.

A budget can override the global list with its `alertThresholds` column
(`Int[]`, empty means "use the global list"). Example: a budget with
`alertThresholds = [50, 90]` alerts at 50% and 90% only. The override is set
through the API (`POST /budgets`, `PATCH /budgets/:id`) as `alertThresholds` and
is validated at DTO time: whole numbers, strictly ascending, each in `1..100`,
and at most 20 entries. An invalid list is rejected with a standard validation
`400` before any budget row is written.

## Evaluation

`BudgetService.consume()` records realised spend and then calls
`BudgetAlertService.evaluate()` inside the existing per-budget Redis lock. For
each configured threshold at or below the current usage percentage it:

1. Inserts a row into `budget_alerts` for
   `(budgetId, periodStart, threshold)`. The unique constraint makes this the
   single source of truth for "already alerted".
2. If (and only if) the insert succeeded, emits the typed domain event
   `budget.threshold_reached` with:

```ts
{
  budgetId: string;
  period: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY' | 'ONE_TIME';
  periodStart: string;   // ISO-8601
  threshold: number;     // 80, 100, or the configured override
  usage: string;         // 7 decimals
  limit: string;         // 7 decimals
  utilisation: string;   // percent, 2 decimals
  currency: string;
}
```

### Period rollover

`periodStart` is derived from the budget's anchor (`periodStart`) and its
`period`, advanced to the period containing "now". A new period therefore
produces new ledger keys, which naturally resets duplicate-alert tracking.
`ONE_TIME` budgets never roll over.

### Failure isolation

The spend has already been committed when alerts are evaluated. Evaluation
catches and logs its own failures and never throws, so a broken event bus or
notification channel cannot roll back or fail the original spend.

## Notification consumption

`BudgetAlertWorker` listens for `budget.threshold_reached` and:

1. Looks up the ledger row by `(budgetId, periodStart, threshold)`.
2. Claims it with a conditional `UPDATE … WHERE notifiedAt IS NULL`.
3. Broadcasts one in-app notification per active organization member.

The conditional update makes consumption idempotent: a re-delivered event or a
second worker finds the row already claimed and creates nothing. Notification
failures are logged and swallowed.

## Topics for webhook subscribers

`budget.threshold_reached` is part of the external webhook event set, so
subscribers can react to a threshold crossing in addition to in-app
notifications.
