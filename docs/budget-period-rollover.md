# Budget Period Rollover

Fixed-period budgets (daily, weekly, monthly, quarterly and yearly) are advanced
by a scheduled worker. `ONE_TIME` budgets are never rolled over.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUDGET_ROLLOVER_ENABLED` | `true` | Turns the repeatable scheduler registration on/off. |
| `BUDGET_ROLLOVER_INTERVAL_MINUTES` | `1` | Minutes between scheduled ticks. |
| `BUDGET_ROLLOVER_BATCH_SIZE` | `100` | Expired budgets read per page. |
| `BUDGET_ROLLOVER_MAX_BATCHES` | `20` | Upper bound on pages processed in one tick. |

The job is a single BullMQ repeatable scheduler with the stable id
`budget-rollover`, so restarts do not create duplicate schedules. A one-off run
can be enqueued with `BudgetRolloverScheduler.trigger()`.

## Period boundaries

Each budget stores:

- `periodStart` / `periodEnd`: the current fixed window (`periodEnd` is null for
  `ONE_TIME` budgets).
- `periodAnchor`: the immutable first window. Arithmetic is always relative to
  this anchor, so a budget created on January 31 opens March on March 31 even
  though its February window ends on February 28.
- `periodIndex`: how many periods have elapsed since the anchor.
- `timezone`: an IANA timezone (for example `Africa/Lagos`) used for wall-clock
  boundaries. Invalid timezones are rejected with a `422` via the budget DTO.
- `carryOverRule`: how much of the closing balance moves into the next window.

Boundaries are half-open: `[periodStart, periodEnd)`. Daily and weekly windows
keep local midnight; DST transitions therefore produce 23-hour or 25-hour days
where applicable.

## Carry-over rules

| Rule | Opening balance |
| --- | --- |
| `NONE` | `0` — spend resets completely (default). |
| `UNUSED` | `max(limit - spent, 0)` — unused budget only. |
| `OVERSPEND` | `min(limit - spent, 0)` — overspend only. |
| `NET` | `limit - spent` — both unused budget and overspend. |

The opening balance becomes the next window's `spent`, so limits represent the
total available amount including carry-over.

## Idempotency and concurrency

- `budget_periods` has a unique `(budgetId, periodStart)` key.
- `closePeriod` upserts the closing snapshot; `openPeriod` records a unique-key
  violation as "already opened" and reuses the stored opening balance.
- A single budget is processed inside one `SELECT … FOR UPDATE` row lock, so two
  replicas cannot open the same window twice.
- If the worker was down for several windows, all elapsed windows are closed in
  one transaction and `periodIndex` advances to the current period.
- Domain event emission happens after the transaction commits; event failures
  are logged and never roll back the period rollover.

## Domain event

`budget.period_rollover` is emitted once per completed rollover:

```ts
{
  budgetId: string;
  organizationId: string;
  closedPeriodStart: string; // ISO-8601
  closedPeriodEnd: string;   // ISO-8601
  periodStart: string;       // ISO-8601
  periodEnd: string;         // ISO-8601
  spent: string;             // final spend of the closed window, 7 decimals
  carryOverAmount: string;   // 7 decimals
  carryOverRule: 'NONE' | 'UNUSED' | 'OVERSPEND' | 'NET';
  periodsClosed: number;
  timezone: string;
  currency: string;
}
```

## Verification

- `src/modules/budgets/utils/period.util.spec.ts` covers timezone, DST,
  month-end anchoring and carry-over math.
- `src/modules/budgets/services/budget-rollover.service.spec.ts` covers batching,
  failure isolation, carry-over variants and commit-then-event ordering.
- `src/modules/budgets/services/budget-rollover.idempotency.integration.spec.ts`
  uses a real Postgres `DATABASE_URL` to prove that concurrent workers open one
  period set and emit one event. It is skipped when `DATABASE_URL` is unset.
