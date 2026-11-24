# Webhook Delivery Reliability and Signatures

## Signature format

Every delivery is signed with the endpoint's own `secret` using HMAC-SHA256.
The canonical signed message is:

```
<timestamp>.<raw request body>
```

- `<timestamp>` is the Unix time in **seconds** of the attempt.
- `<raw request body>` is the exact bytes sent, with no re-serialization.

The header carries the timestamp inside the signature (Stripe-style):

```
X-Astroid-Signature: t=<unix-seconds>,v1=<hex-hmac>
X-Astroid-Signature-Version: v1
X-Astroid-Event: <domain-event-name>
```

`X-Astroid-Event-Id` (and its alias `X-Astroid-Delivery`) still carry the
globally unique event identifier; the HMAC itself is computed only over the
canonical signed message above, so `v1` is the hex HMAC of
`${t}.${rawBody}` where `t` is the same timestamp as in the header.

### Consumer verification

1. Read the **raw** request body bytes before JSON parsing.
2. Parse `X-Astroid-Signature` into `t` and `v1`.
3. Reject stale timestamps: `|now − t|` must be within the tolerance window
   (the docs recommend **5 minutes**, 300 seconds).
4. Compute `expected = HMAC-SHA256(secret, `${t}.${rawBody}`)` and compare it
   with the received `v1` digest in constant time (check both lengths first).
5. Reject anything that does not match.

Node example:

```ts
import { createHmac, timingSafeEqual } from 'crypto';

function verify(rawBody: Buffer, headers: Record<string, string>, secret: string) {
  const signature = headers['x-astroid-signature'];
  if (typeof signature !== 'string') return false;
  const { t, v1 } = parseSignatureHeader(signature); // t=<unix-seconds>,v1=<hex>
  if (!t || !/^\d{1,12}$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${t}.`), rawBody])).digest();
  const received = Buffer.from(v1, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function parseSignatureHeader(header: string): { t?: string; v1?: string } {
  const out: { t?: string; v1?: string } = {};
  for (const part of header.split(',')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 't') out.t = rest.join('=');
    if (key === 'v1') out.v1 = rest.join('=');
  }
  return out;
}
```

`verifyWebhookSignature` in `src/modules/webhooks/utils/signing.ts` implements the
same check for tests and tooling.

## Retry policy

Deliveries run on the BullMQ webhooks queue with exponential backoff and ±20%
jitter, capped by `WEBHOOK_BACKOFF_MAX_DELAY_MS`.

- **Retried:** `408`, `429`, every `5xx`, timeouts, DNS failures and other
  network errors.
- **Not retried:** every other `4xx` (for example `400`, `404`, `409`, `422`,
  `425`) and every `3xx` redirect. These are permanent rejections.
- **Attempts:** `WEBHOOK_MAX_ATTEMPTS` (default 5, including the initial
  delivery). Exhausted jobs are retained and dead-lettered for inspection.

### HTTP 410 Gone

`410 Gone` is treated as a **permanent** rejection, like every other `4xx`
that is not `408`, `425` or `429`: the delivery is attempted once and never
retried, because the subscriber has explicitly declared the resource gone and
a retry cannot change that answer.

It deliberately does **not** disable the subscription. A `410` can come from a
misconfigured endpoint, a proxy or a temporary backend deployment, so the
platform reports it (delivery status `FAILED`, `failureCode: HTTP_410`, an
attempt-history row, a terminal-failure audit entry when it consumes the final
attempt) and leaves it to the subscriber to fix or delete the endpoint. This
keeps an integrator from silently losing events because of one bad response.

## Delivery deduplication

Every delivery job is enqueued under a deterministic job id:

```
webhook-delivery-<urlencoded eventId>|<urlencoded webhookId>
```

BullMQ ignores an `add` whose id already exists in the queue (waiting, active,
delayed, failed or retained-completed), so the same event cannot be delivered
twice to the same subscription — in particular it cannot be delivered twice
**concurrently**. This covers duplicate dispatches, a retried API call and an
operator replay racing the original job.

BullMQ's job lifecycle bounds the deduplication window:

- completed jobs are kept for the last 1,000 deliveries;
- failed jobs are kept for 24 hours or the last 5,000, whichever comes first
  (`WEBHOOK_FAILED_JOB_RETENTION_SECONDS`).

After the record is removed, the same event/subscription pair can be enqueued
again. That is intended: event ids are unique per event, so a re-enqueue after
retention is an explicit new delivery, not an accidental duplicate.

## Dead-letter operations

A delivery that exhausts its attempts is routed to the `dead-letter` queue with
the original queue, job id and name, the webhook/event identifiers, attempt
count, failed reason and timestamp. The event payload itself is not duplicated
into the dead-letter entry — the original failed job and the
`webhook_delivery_attempts` rows still hold it — which keeps tenant data out of
a second retention window.

The same terminal failure is also written to the durable `dead_letter` ledger.

**Inspect.** Operators with the `OWNER` or `ADMIN` role can list the ledger,
optionally restricted to the webhook queue:

```bash
curl -s "$API/api/v1/admin/dead-letter?queue=webhooks&page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

To see the raw BullMQ entries instead, including the retained failed jobs:

```bash
redis-cli -n "${REDIS_DB:-0}" --scan --pattern 'bull:dead-letter:*'
redis-cli -n "${REDIS_DB:-0}" --scan --pattern 'bull:webhooks:webhook-delivery-*'
```

**Replay.** Re-drive a failed delivery after the subscriber has been fixed:

```bash
curl -s -X POST "$API/api/v1/admin/dead-letter/webhooks/<jobId>/retry" \
  -H "Authorization: Bearer $TOKEN"
```

The original failed job stays in place for audit; a new job is enqueued with a
fresh id (`dlq-retry-<jobId>-<timestamp>`), so BullMQ's id deduplication alone
cannot protect the retry. The re-drive therefore first looks up the
deterministic delivery id for the same event and subscription and answers
`409 Conflict` when that delivery is still waiting, delayed or active. Once
nothing is in flight, the replay is safe and cannot produce two concurrent
deliveries of one event.

**Purge.** After review, remove a hopeless failed job:

```bash
curl -s -X DELETE "$API/api/v1/admin/dead-letter/webhooks/<jobId>" \
  -H "Authorization: Bearer $TOKEN"
```

Configuration lives in the existing webhook config slice:

| Variable | Default |
|---|---|
| `WEBHOOK_MAX_ATTEMPTS` | `5` |
| `WEBHOOK_BACKOFF_BASE_DELAY_MS` | `2000` |
| `WEBHOOK_BACKOFF_MAX_DELAY_MS` | `60000` |
| `WEBHOOK_REQUEST_TIMEOUT_MS` | `5000` |
| `WEBHOOK_CIRCUIT_ENABLED` | `true` |
| `WEBHOOK_CIRCUIT_FAILURE_THRESHOLD` | `5` |
| `WEBHOOK_CIRCUIT_COOLDOWN_MS` | `300000` |

## Attempt history

`webhook_deliveries` keeps the current state of a delivery (status, attempt
count, last response, next retry). The new `webhook_delivery_attempts` table is
an append-only row per HTTP attempt containing:

- `webhookId` (endpoint), `organizationId`, `eventId`
- `attemptNumber`
- `status` (`SUCCEEDED` / `FAILED`)
- `responseStatus`, `durationMs`
- `errorCode` and a bounded `errorMessage`

Attempt persistence is best-effort: it never changes the delivery outcome and
its failure is only logged.

## Backward compatibility

The payload shape, endpoint CRUD API and header names are unchanged; the
`X-Astroid-Signature` header format is the canonical Stripe-style
`t=<unix-seconds>,v1=<hex-hmac>` where the HMAC is over `${t}.${rawBody}`
(previously `v1=<hex>` over `v1.<t>.<eventId>.<body>`; the separate
`X-Astroid-Timestamp` header is still sent for convenience). The other
behavioural change is that a delivery previously retried on `425`, `405`,
`409`, `410` and `415` is now abandoned immediately, as required by the retry
contract.
