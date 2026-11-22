# Webhook Delivery Reliability and Signatures

## Signature format

Every delivery is signed with the endpoint's own `secret` using HMAC-SHA256.
The signed string is:

```
v1.<timestamp>.<eventId>.<raw request body>
```

- `<timestamp>` is Unix time in **seconds**, also sent as `X-Astroid-Timestamp`.
- `<eventId>` is sent as `X-Astroid-Event-Id` (and `X-Astroid-Delivery`).
- `<raw request body>` is the exact bytes sent, with no re-serialization.

The digest is hex-encoded and sent as:

```
X-Astroid-Signature: v1=<hex digest>
X-Astroid-Timestamp: <unix seconds>
X-Astroid-Signature-Version: v1
```

The same payload is also described by `X-Astroid-Event`.

### Consumer verification

1. Read the **raw** request body bytes before JSON parsing.
2. Read `X-Astroid-Timestamp`, `X-Astroid-Event-Id` and `X-Astroid-Signature`.
3. Build `v1.<timestamp>.<eventId>.` followed by the raw body.
4. Compute `HMAC-SHA256(secret, signedString)` and compare it with the hex
   digest in constant time.
5. Reject stale timestamps (a small tolerance such as 5 minutes limits replay)
   and reject deliveries whose signature does not match.

Node example:

```ts
import { createHmac, timingSafeEqual } from 'crypto';

function verify(rawBody: Buffer, headers: Record<string, string>, secret: string) {
  const timestamp = headers['x-astroid-timestamp'];
  const eventId = headers['x-astroid-event-id'];
  const signature = headers['x-astroid-signature'];
  if (!timestamp || !eventId || !signature?.startsWith('v1=')) return false;

  const signed = Buffer.concat([Buffer.from(`v1.${timestamp}.${eventId}.`), rawBody]);
  const expected = createHmac('sha256', secret).update(signed).digest();
  const received = Buffer.from(signature.slice(3), 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
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

The payload shape, endpoint CRUD API and header names are unchanged. The only
behavioural change is that a delivery previously retried on `425`, `405`, `409`,
`410` and `415` is now abandoned immediately, as required by the retry contract.
