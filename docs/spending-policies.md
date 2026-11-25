# Spending Policies

The spending-policy layer decides whether an agent may move money. It is the
last gate before a transaction is queued for execution, so every rule is
evaluated **before** the transaction is persisted and before it can reach the
blockchain execution queue.

## Layers

| Layer | Location | Responsibility |
|-------|----------|----------------|
| Policy engine | `src/modules/policies/policy.engine.ts` | Pure, synchronous evaluation of an intent against the applicable policies. No I/O. |
| Policy service | `src/modules/policies/policy.service.ts` | Loads the applicable policies, converts amounts into the currency a policy is denominated in and merges the results. |
| Spending-limit service | `src/modules/transactions/spending-limit.service.ts` | Enriches an intent with the spend already accumulated per asset and records the violation in the audit trail. |
| Asset registry | `src/modules/policies/asset-registry.service.ts` | Resolves an asset to its canonical Stellar identifier. |
| Price oracle | `src/modules/policies/price-oracle.service.ts` | Converts an amount into a base currency. Fails closed. |

## Assets

A transfer refers to an asset by its ticker (`XLM`, `USDC`) or by the canonical
network form `CODE:ISSUER`. The asset registry resolves both to the same
canonical identifier:

- `XLM` is the native asset.
- `CODE:ISSUER` is used as-is.
- A bare ticker that is listed in `STELLAR_ANCHOR_ASSETS` is expanded to
  `CODE:ISSUER`, so a request for `USDC` and a request for
  `USDC:GA5Z…` describe the same asset and their spend is aggregated together.

Only the asset *code* is used to match policy configuration, so an issued
asset (`USDC:GA5Z…`) matches the `USDC` entry of an allow list or of a
per-asset limit.

## Single-asset and multi-asset transfers

An intent carries one or more transfer *legs*:

- A single-asset payload (`asset` + `amount`) is the degenerate case with
  exactly one leg, so the behaviour of existing policies is unchanged.
- A multi-asset payload (`transfers[]`) has one leg per asset. Every leg is
  evaluated independently, and an asset may appear at most once per payload.

The multi-asset payload is accepted by the simulation endpoints
(`POST /transactions/simulate` and `POST /policies/simulate`), which evaluate
a transfer without moving funds. `POST /transactions` moves a single asset per
transaction — the `Transaction` record models one asset — and rejects a
`transfers` array with an explanatory error.

## Limits

A policy configuration may declare:

| Field | Meaning |
|-------|---------|
| `maxAmount` / `minAmount` | Per-transfer limits, applied to every leg. |
| `dailyLimit` / `weeklyLimit` / `monthlyLimit` | Periodic limits, compared against the spend accumulated **for the asset of the leg**. |
| `assetLimits` | Per-asset overrides, keyed by the upper-case asset code. An entry replaces the policy-wide limits for that asset. |
| `baseCurrency` | Currency the amount limits are denominated in (e.g. `USD`). |

```json
{
  "baseCurrency": "USD",
  "maxAmount": 500,
  "assetLimits": {
    "XLM": { "maxAmount": 50, "dailyLimit": 200 },
    "USDC": { "maxAmount": 1000, "dailyLimit": 5000 }
  }
}
```

## Base-currency conversion

When a policy declares a `baseCurrency`, the transfer amount — and the spend
already accumulated for the asset — are converted into that currency before
the limits are applied. The conversion uses the price oracle, which supports
two sources:

1. `PRICE_ORACLE_STATIC_PRICES` — an operator-managed quote table, consulted
   first and considered fresh at all times.
2. `PRICE_ORACLE_URL` — a provider-neutral JSON endpoint that receives
   `?base=<BASE>&assets=<ASSET>` and answers with
   `{ "quotes": { "XLM": { "price": 0.11, "asOf": "2026-01-01T00:00:00Z" } } }`.

A quote that is missing, malformed, unreachable or older than
`PRICE_ORACLE_MAX_AGE_MS` aborts the evaluation with a `PRICE_UNAVAILABLE`
error (HTTP 503). An unknown price is never treated as zero: a limit that
cannot be evaluated blocks the transaction.

## Violations

A blocked transaction is rejected with HTTP `422` and a `POLICY_VIOLATION`
problem-details body. Every violated rule is reported with its policy, its
code, a human-readable message and the asset it applies to:

```json
{
  "violations": [
    {
      "policyId": "018f...",
      "policyName": "USDC cap",
      "code": "DAILY_LIMIT_EXCEEDED",
      "message": "Projected daily spend 600 USDC exceeds limit 500 USDC",
      "asset": "USDC"
    }
  ]
}
```

The violation is also written to the audit trail as a `SPENDING_LIMIT_EXCEEDED`
entry before the request is rejected, so the compliance record is complete even
for a blocked payment.

## Budgets

A budget is denominated in a single currency. When a transaction names a
budget, the budget must be active and denominated in the asset of the
transfer; comparing an XLM amount against a USDC budget would silently mix
units, so the check fails closed with a `BUDGET_EXCEEDED` error instead.
