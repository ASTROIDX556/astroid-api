# Webhook Signatures & Security Guide

Astroid signs all outgoing webhook events with an HMAC-SHA256 signature to guarantee payload authenticity, integrity, and replay attack protection. Integrators hosting webhook endpoints can cryptographically verify that every incoming HTTP request originated from Astroid and has not been altered or delayed in transit.

---

## 1. Security Architecture & Key Principles

1. **HMAC-SHA256 Signing**: Every delivery is signed using an endpoint-specific signing secret.
2. **Encrypted at Rest**: Webhook signing secrets are encrypted with AES-256-GCM in Astroid's database. Plaintext secrets are revealed **only once** upon creation or rotation (`whsec_...`) and can never be re-read.
3. **Replay Protection**: Deliveries carry a Unix timestamp (`X-Astroid-Timestamp` or `t=<timestamp>`). Consumers are expected to enforce a **5-minute (300 seconds)** tolerance window to prevent replay of intercepted payloads.
4. **Fresh Timestamps on Retries**: Signing occurs in the delivery execution path. Each retry computes a fresh timestamp and a corresponding valid signature.
5. **Exact Raw Bytes**: The signature is computed directly over the raw, unparsed request body bytes (`Buffer`), guaranteeing byte-for-byte fidelity without formatting or JSON serialization differences.

---

## 2. HTTP Headers Sent With Every Delivery

Every outgoing webhook POST request includes the following standard headers:

| Header Name | Example | Description |
|---|---|---|
| `X-Astroid-Signature` | `v1=7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069` | HMAC-SHA256 hex digest prefixed by the signature scheme version. Supports versioned formats including `t=<unix-seconds>,v1=<hex>`. |
| `X-Astroid-Timestamp` | `1700000000` | Unix epoch time in seconds when the request was signed. |
| `X-Astroid-Signature-Version` | `v1` | Signature scheme version (currently `v1`). |
| `X-Astroid-Event` | `transaction.completed` | Name of the domain event being delivered. |
| `X-Astroid-Event-Id` | `018f0a1b-5555-4000-8000-000000000000` | Globally unique event identifier. |
| `X-Astroid-Delivery` | `018f0a1b-5555-4000-8000-000000000000` | Backward-compatible alias for the delivery event ID. |
| `Content-Type` | `application/json` | Request payload MIME type. |
| `User-Agent` | `Astroid-Webhook-Bot/1.0` | Client user agent. |

---

## 3. Signature Algorithm

The signature is computed over a concatenated byte buffer composed of the signature scheme version, the timestamp, the event ID, and the exact raw request body bytes:

```
v1.<timestamp>.<eventId>.<raw_body_bytes>
```

### Steps to Compute:
1. Format prefix: `v1.${timestamp}.${eventId}.` encoded as UTF-8 bytes.
2. Concatenate the prefix bytes with the exact raw body bytes.
3. Compute `HMAC-SHA256` using the endpoint's signing secret (`whsec_...`).
4. Hex-encode the resulting digest: `v1=<hex_digest>`.

---

## 4. Consumer Verification Guide

To securely verify an incoming delivery:

1. **Extract Headers**:
   - Extract `X-Astroid-Signature` (or the versioned `v1` hash and timestamp).
   - Extract `X-Astroid-Timestamp` and `X-Astroid-Event-Id`.
2. **Validate Timestamp (Replay Defense)**:
   - Check that the timestamp is a valid integer.
   - Calculate `Math.abs(currentTime - timestamp)`. If the absolute difference exceeds **300 seconds (5 minutes)**, reject the request (HTTP 401 or 400).
3. **Verify Raw Body**:
   - Do NOT parse JSON before verifying the signature. Formatting differences (whitespace, key ordering, float serialization) will cause signature mismatches.
4. **Compute Expected HMAC**:
   - Compute `HMAC-SHA256(secret, Buffer.concat([Buffer.from("v1." + timestamp + "." + eventId + "."), rawBody]))`.
5. **Constant-Time Comparison**:
   - Compare the expected digest with the received digest using a timing-safe equality function (e.g., `crypto.timingSafeEqual`) to mitigate timing attacks.

---

## 5. Verification Code Examples

### Node.js / Express / TypeScript

```typescript
import express, { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const app = express();
const WEBHOOK_SECRET = process.env.ASTROID_WEBHOOK_SECRET || 'whsec_...';
const TOLERANCE_SECONDS = 300; // 5 minutes

// IMPORTANT: Capture the raw body Buffer before JSON parsing!
app.use(express.json({
  verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  },
}));

function parseSignatureHeader(header: string): { timestamp?: string; v1?: string } {
  if (header.startsWith('v1=') && !header.includes(',')) {
    return { v1: header.slice(3) };
  }
  const result: { timestamp?: string; v1?: string } = {};
  for (const part of header.split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const val = rest.join('=');
    if (key === 't') result.timestamp = val;
    if (key === 'v1') result.v1 = val;
  }
  return result;
}

function verifyAstroidWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): { valid: boolean; reason?: string } {
  const rawSignature = headers['x-astroid-signature'];
  if (typeof rawSignature !== 'string') {
    return { valid: false, reason: 'Missing X-Astroid-Signature header' };
  }

  const parsed = parseSignatureHeader(rawSignature);
  const timestamp = (headers['x-astroid-timestamp'] as string) || parsed.timestamp;
  const eventId = (headers['x-astroid-event-id'] as string) || (headers['x-astroid-delivery'] as string);
  const v1Signature = parsed.v1;

  if (!timestamp || !eventId || !v1Signature) {
    return { valid: false, reason: 'Missing signature components' };
  }

  // 1. Replay attack check (5-minute tolerance)
  const now = Math.floor(Date.now() / 1000);
  const timestampSeconds = parseInt(timestamp, 10);
  if (isNaN(timestampSeconds) || Math.abs(now - timestampSeconds) > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'Timestamp outside 5-minute tolerance window' };
  }

  // 2. Compute expected HMAC
  const input = Buffer.concat([
    Buffer.from(`v1.${timestamp}.${eventId}.`, 'utf8'),
    rawBody,
  ]);
  const expectedDigest = createHmac('sha256', secret).update(input).digest();
  const receivedDigest = Buffer.from(v1Signature, 'hex');

  // 3. Constant-time comparison
  if (expectedDigest.length !== receivedDigest.length || !timingSafeEqual(expectedDigest, receivedDigest)) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  return { valid: true };
}

app.post('/api/webhooks/astroid', (req: Request & { rawBody?: Buffer }, res: Response) => {
  if (!req.rawBody) {
    return res.status(400).send('Raw body missing');
  }

  const verification = verifyAstroidWebhook(req.rawBody, req.headers, WEBHOOK_SECRET);
  if (!verification.valid) {
    console.warn(`[Webhook Rejected]: ${verification.reason}`);
    return res.status(401).send(`Unauthorized: ${verification.reason}`);
  }

  const event = req.body;
  console.log(`Received verified event: ${event.event} (${req.headers['x-astroid-event-id']})`);

  // Process event asynchronously or return 200 immediately
  return res.status(200).json({ received: true });
});
```

---

### Python (FastAPI)

```python
import hmac
import hashlib
import time
from fastapi import FastAPI, Request, HTTPException, Header

app = FastAPI()
WEBHOOK_SECRET = "whsec_..."
TOLERANCE_SECONDS = 300

@app.post("/api/webhooks/astroid")
async def handle_astroid_webhook(
    request: Request,
    x_astroid_signature: str = Header(...),
    x_astroid_timestamp: str = Header(...),
    x_astroid_event_id: str = Header(...),
):
    # 1. Capture raw request body bytes
    body_bytes = await request.body()

    # 2. Replay attack protection
    try:
        ts = int(x_astroid_timestamp)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid timestamp format")

    now = int(time.time())
    if abs(now - ts) > TOLERANCE_SECONDS:
        raise HTTPException(status_code=401, detail="Timestamp out of tolerance window")

    # 3. Parse signature (handles v1=<hex> or t=...,v1=<hex>)
    v1_sig = None
    for part in x_astroid_signature.split(","):
        k, _, v = part.strip().partition("=")
        if k == "v1":
            v1_sig = v
    if not v1_sig:
        raise HTTPException(status_code=400, detail="Missing v1 signature")

    # 4. Compute expected HMAC
    prefix = f"v1.{x_astroid_timestamp}.{x_astroid_event_id}.".encode("utf-8")
    expected_hmac = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"),
        prefix + body_bytes,
        hashlib.sha256,
    ).hexdigest()

    # 5. Constant-time comparison
    if not hmac.compare_digest(expected_hmac, v1_sig):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    # Safe to parse JSON
    payload = await request.json()
    return {"status": "accepted", "event": payload.get("event")}
```

---

## 6. Troubleshooting & Common Pitfalls

| Issue | Cause | Fix |
|---|---|---|
| `Signature mismatch` | JSON middleware modified formatting or whitespaces before signature calculation. | Ensure verification runs against the **raw body bytes buffer** before any JSON parsing. |
| `Timestamp outside tolerance window` | Server clock is out of sync or event was delayed. | Ensure the server's NTP clock is synchronized. For delayed delivery investigations, inspect retry attempts in Astroid. |
| `Missing signature components` | Proxies or load balancers stripped custom headers (`X-Astroid-*`). | Configure reverse proxy / ingress controllers to allow custom headers through. |
| `Failure to sign (Missing secret)` | The subscriber record in Astroid is missing its secret or it could not be decrypted. | Astroid marks the delivery failed with an explicit audit log reason rather than sending an unsigned payload. |
