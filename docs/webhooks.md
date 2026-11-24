# Webhook Signatures & Security Guide

Astroid signs every outgoing webhook event with an HMAC-SHA256 signature to guarantee payload authenticity, integrity, and replay attack protection. Integrators hosting webhook endpoints can cryptographically verify that every incoming HTTP request originated from Astroid and has not been altered or delayed in transit.

---

## 1. Security Architecture & Key Principles

1. **HMAC-SHA256 Signing**: Every delivery is signed using an endpoint-specific signing secret (`whsec_...`).
2. **Encrypted at Rest**: Webhook signing secrets are encrypted with AES-256-GCM in Astroid's database. Plaintext secrets are revealed **only once** upon creation or rotation and can never be re-read.
3. **Replay Protection**: Deliveries carry a Unix timestamp (`t=<unix-seconds>` inside the `X-Astroid-Signature` header). Consumers are expected to enforce a **5-minute (300 seconds)** tolerance window to prevent replay of intercepted payloads.
4. **Fresh Timestamps on Retries**: Signing occurs in the delivery execution path. Each retry computes a fresh timestamp and a corresponding valid signature.
5. **Exact Raw Bytes**: The signature is computed directly over the raw, unparsed request body bytes (`Buffer`), guaranteeing byte-for-byte fidelity without formatting or JSON serialization differences.

---

## 2. HTTP Headers Sent With Every Delivery

Every outgoing webhook POST request includes the following standard headers:

| Header Name | Example | Description |
|---|---|---|
| `X-Astroid-Signature` | `t=1700000000,v1=7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069` | The signature: `t=<unix-seconds>` is the signing timestamp and `v1=<hex-hmac>` is the HMAC-SHA256 hex digest. Matches the widely used Stripe-style scheme. |
| `X-Astroid-Timestamp` | `1700000000` | Unix epoch time in seconds when the request was signed. |
| `X-Astroid-Signature-Version` | `v1` | Signature scheme version (currently `v1`). |
| `X-Astroid-Event` | `transaction.completed` | Name of the domain event being delivered. |
| `X-Astroid-Event-Id` | `018f0a1b-5555-4000-8000-000000000000` | Globally unique event identifier. |
| `X-Astroid-Delivery` | `018f0a1b-5555-4000-8000-000000000000` | Backward-compatible alias for the delivery event ID. |
| `Content-Type` | `application/json` | Request payload MIME type. |
| `User-Agent` | `Astroid-Webhook-Bot/1.0` | Client user agent. |

---

## 3. Signature Algorithm

The signature is computed over the canonical signed message:

```
${t}.${raw_body_bytes}
```

That is, the decimal Unix timestamp string `t` (the same value as in the header), followed by a literal `.`, followed by the exact raw request body bytes.

### Steps to Compute:
1. Format the prefix: the ASCII bytes of `${t}.` (e.g., `1700000000.`).
2. Concatenate those prefix bytes with the exact raw body bytes (no reformatting, no JSON serialization).
3. Compute `HMAC-SHA256` using the endpoint's signing secret (`whsec_...`).
4. Hex-encode the resulting digest and format the header as `t=${t},v1=${hex}`.

---

## 4. Consumer Verification Guide

To securely verify an incoming delivery:

1. **Extract Headers**:
   - Extract `X-Astroid-Signature` → parse it into `t` (the Unix timestamp) and `v1` (the hex digest).
   - Extract the raw request body bytes before any JSON parsing.
2. **Validate Timestamp (Replay Defense)**:
   - Check that `t` is a valid integer (digits only).
   - Compute `Math.abs(currentTime - t)`. If the absolute difference exceeds **300 seconds (5 minutes)**, reject the request (HTTP 401 or 400).
3. **Verify the Signature**:
   - Compute the expected digest: `HMAC-SHA256(secret, Buffer.concat([Buffer.from(`${t}.`), rawBody]))` and hex-encode it.
   - Do NOT parse the JSON payload before verifying — formatting differences (whitespace, key ordering, float serialization) will cause signature mismatches.
4. **Constant-Time Comparison**:
   - Compare the expected digest with the received `v1` digest using a timing-safe equality function (e.g., `crypto.timingSafeEqual`), after checking that both are 64-character lowercase hex strings of equal length, to mitigate timing attacks.

---

## 5. Verification Code Examples

### Node.js / Express / TypeScript

```typescript
import express, { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const app = express();
const WEBHOOK_SECRET = process.env.ASTROID_WEBHOOK_SECRET || 'whsec_...';
const TOLERANCE_SECONDS = 300; // 5 minutes, the recommended replay window

// IMPORTANT: Capture the raw body Buffer before JSON parsing!
app.use(express.json({
  verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = buf;
  },
}));

function parseSignatureHeader(header: string): { t?: string; v1?: string } {
  const result: { t?: string; v1?: string } = {};
  for (const part of header.split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const val = rest.join('=');
    if (key === 't') result.t = val;
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
  const t = parsed.t;
  const v1Signature = parsed.v1;

  if (!t || !v1Signature) {
    return { valid: false, reason: 'Missing signature components' };
  }

  // 1. Replay attack check (5-minute tolerance)
  if (!/^\d{1,12}$/.test(t)) {
    return { valid: false, reason: 'Malformed timestamp' };
  }
  const timestampSeconds = Number(t);
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'Timestamp outside 5-minute tolerance window' };
  }

  // 2. Compute expected HMAC over `${t}.${rawBody}`
  if (!/^[0-9a-f]{64}$/.test(v1Signature)) {
    return { valid: false, reason: 'Malformed signature digest' };
  }
  const expectedDigest = createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${t}.`), rawBody])).digest();
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
  return res.status(200).json({ received: true });
});
```

### curl and OpenSSL (manual verification)

Save the exact raw body from the delivery to `body.json` and copy its
`X-Astroid-Signature` header below. This checks the five-minute replay window
and recomputes the HMAC over the original bytes:

```bash
export WEBHOOK_SECRET='whsec_...'
SIGNATURE_HEADER='t=1700000000,v1=<64-character-hex-digest>'
TIMESTAMP="${SIGNATURE_HEADER#t=}"
TIMESTAMP="${TIMESTAMP%%,*}"
RECEIVED="${SIGNATURE_HEADER#*,v1=}"
NOW="$(date +%s)"
AGE="$((NOW - TIMESTAMP))"

if [ "$AGE" -lt -300 ] || [ "$AGE" -gt 300 ]; then
  echo 'timestamp outside the 5-minute replay window' >&2
  exit 1
fi

EXPECTED="$(
  { printf '%s.' "$TIMESTAMP"; cat body.json; } |
    openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex |
    awk '{print $NF}'
)"
if [ "$EXPECTED" != "$RECEIVED" ]; then
  echo 'signature mismatch' >&2
  exit 1
fi
echo 'signature valid'

# Optionally replay the captured request to a local verification listener.
curl --fail-with-body --request POST 'http://localhost:3000/api/webhooks/astroid' \
  --header "X-Astroid-Signature: $SIGNATURE_HEADER" \
  --header 'X-Astroid-Event: transaction.completed' \
  --header 'Content-Type: application/json' \
  --data-binary @body.json
```

The shell comparison is for manual inspection only. Production consumers must
use a timing-safe digest comparison, as in the Node example above, and should
also prevent duplicate event IDs from being processed more than once.

---

### Python (FastAPI)

```python
import hmac
import hashlib
import time
from fastapi import FastAPI, Request, HTTPException, Header

app = FastAPI()
WEBHOOK_SECRET = "whsec_..."
TOLERANCE_SECONDS = 300  # 5 minutes

@app.post("/api/webhooks/astroid")
async def handle_astroid_webhook(
    request: Request,
    x_astroid_signature: str = Header(...),
):
    # 1. Capture raw request body bytes
    body_bytes = await request.body()

    # 2. Parse the signature header into `t` and `v1`
    t = None
    v1_sig = None
    for part in x_astroid_signature.split(","):
        k, _, v = part.strip().partition("=")
        if k == "t":
            t = v
        elif k == "v1":
            v1_sig = v
    if not t or not v1_sig:
        raise HTTPException(status_code=400, detail="Missing signature components")

    # 3. Replay attack protection (5-minute tolerance)
    try:
        ts = int(t)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid timestamp format")
    if abs(int(time.time()) - ts) > TOLERANCE_SECONDS:
        raise HTTPException(status_code=401, detail="Timestamp out of tolerance window")

    # 4. Compute expected HMAC over `${t}.${rawBody}`
    expected_hmac = hmac.new(
        WEBHOOK_SECRET.encode("utf-8"),
        f"{t}.".encode("utf-8") + body_bytes,
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
| `Malformed signature digest` | The `v1` value is not a 64-character lowercase hex string (e.g., non-hex characters, uppercase, or truncated). | Reject the request; only accept the documented `v1=<hex>` format. |
| `Missing signature components` | Proxies or load balancers stripped custom headers (`X-Astroid-*`). | Configure reverse proxy / ingress controllers to allow custom headers through. |
| `Failure to sign (Missing secret)` | The subscriber record in Astroid is missing its secret or it could not be decrypted. | Astroid marks the delivery failed with an explicit audit log reason rather than sending an unsigned payload. |
| `Signature verification fails for fresh deliveries` | You are verifying over the JSON-parsed body rather than the exact bytes received. | Re-serializing the body can produce a different byte string than what was sent (key order, whitespace). Capture the raw body before parsing. |
