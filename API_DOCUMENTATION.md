# Astroid API Documentation Reference

## Authentication Endpoints (`/auth`)

# POST `/auth/register`
Register a new organization and its owner.

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| organizationName | string | Yes | 2-120 chars | Name of the organization |
| name | string | Yes | 1-120 chars | Full name of the owner |
| email | string | Yes | Valid email | Owner's email address |
| password | string | Yes | 8-200 chars | Secure password |

**Response:** `TokenPairDto`
| Field | Type | Description |
|-------|------|-------------|
| accessToken | string | JWT access token |
| refreshToken | string | JWT refresh token |
| expiresIn | number | Access token lifetime in seconds (default: 900) |
| tokenType | string | Token type (optional) |

### POST `/auth/login`
Authenticate with email and password.

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| email | string | Yes | Valid email | User's email address |
| password | string | Yes | Non-empty | User's password |

**Response:** `TokenPairDto`

### POST `/auth/refresh`
Rotate an access/refresh token pair.

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| refreshToken | string | Yes | Non-empty | Valid refresh token |

**Response:** `TokenPairDto`

### POST `/auth/logout`
Revoke the current session.

**Authentication:** Bearer token required

**Response:** Success message

### GET `/auth/me`
Get the current authenticated user.

**Authentication:** Bearer token required

**Response:** User profile information

### GET `/auth/session`
Get the current session principal (alias for `/auth/me`).

**Authentication:** Bearer token required

**Response:** User profile information

### POST `/auth/passkey/register`
Begin WebAuthn passkey registration.

**Status:** Not implemented - requires `@simplewebauthn/server` package

### POST `/auth/passkey/verify`
Verify a WebAuthn passkey assertion.

**Status:** Not implemented - requires `@simplewebauthn/server` package

---

## Wallet Endpoints (`/wallets`)

### GET `/wallets`
List wallets for the organization.

**Query Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| offset | number | No | Rows to skip (default: 0); mutually exclusive with `page` |
| page | number | No | Page number, alternative to `offset` (default: 1) |
| limit | number | No | Items per page (default: 50, max: 200) |

**Authentication:** Bearer token required

**Response:** Paginated list of wallets

### POST `/wallets`
Create a wallet (generate a keypair or import an address).

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE, DEVELOPER

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| label | string | No | 1-120 chars, whitespace normalized | Wallet label/name |
| walletType | enum | No | AGENT, OPERATIONAL, TREASURY | Type of wallet (default: AGENT) |
| network | enum | No | TESTNET, PUBLIC | Stellar network (default: TESTNET) |
| agentId | string | No | Valid UUID | Owning agent ID |
| stellarAddress | string | No | Stellar account address (`G…`), checksum validated | Import existing address (if provided, no keypair is generated) |

Only Stellar **accounts** can be imported: a contract ID (`C…`) or a
multiplexed address (`M…`) cannot hold a balance or sign for the wallet and is
rejected. Unknown properties are rejected as well.

**Response:** `WalletSecretDto` (on generation) or wallet object (on import)
| Field | Type | Description |
|-------|------|-------------|
| stellarAddress | string | Public Stellar address (G...) |
| secretKey | string | Generated secret key (S...) - shown ONCE, never stored |

### GET `/wallets/:id`
Get a specific wallet.

**Authentication:** Bearer token required

**Response:** Wallet details

### GET `/wallets/:id/balances`
Fetch live on-chain balances for a wallet.

**Authentication:** Bearer token required

**Response:** Balance information for all assets

### PATCH `/wallets/:id`
Update a wallet label or owning agent.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE, DEVELOPER

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| label | string | No | 1-120 chars, whitespace normalized | New wallet label |
| agentId | string | No | Valid UUID or null | Reassign or clear owning agent |

At least one field must be supplied: an empty body would be a no-op that still
writes an audit entry and is rejected with a validation error.

**Response:** Updated wallet object

### POST `/wallets/:id/freeze`
Freeze a wallet (block outgoing transactions).

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Response:** Updated wallet with FROZEN status

### POST `/wallets/:id/unfreeze`
Unfreeze a wallet.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Response:** Updated wallet with ACTIVE status

### DELETE `/wallets/:id`
Archive (soft-delete) a wallet.

**Authentication:** Requires roles: OWNER, ADMIN

**Response:** Success message

---

## Transaction Endpoints (`/transactions`)

### GET `/transactions`
List transactions for the organization.

**Query Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| offset | number | No | Rows to skip (default: 0); mutually exclusive with `page` |
| page | number | No | Page number, alternative to `offset` (default: 1) |
| limit | number | No | Items per page (default: 50, max: 200) |

**Authentication:** Bearer token required

**Response:** Paginated list of transactions

### POST `/transactions`
Create a transaction (runs the full governance pipeline).

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE, DEVELOPER

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| walletId | string | Yes | Valid UUID | Sender wallet ID |
| agentId | string | No | Valid UUID | Initiating agent ID |
| budgetId | string | No | Valid UUID | Budget to charge against |
| asset | string | No | `CODE` or `CODE:ISSUER`, max 80 chars | Asset code (default: XLM). A Stellar Anchor ticker (e.g. `USDC`) is resolved to its issuing account when it is configured in `STELLAR_ANCHOR_ASSETS`; an issued asset can always be requested explicitly as `CODE:ISSUER` |
| amount | string | Yes | Positive decimal, max 7 decimal places | Transaction amount |
| recipientAddress | string | Yes | Non-empty | Stellar destination address |
| memo | string | No | Max 28 chars | Transaction memo |
| purpose | string | No | Max 280 chars | Transaction purpose |
| metadata | object | No | Arbitrary JSON | Additional metadata |

**Response:** Transaction object with governance evaluation result

A transaction moves a single asset. A payload that carries a `transfers` array
is rejected with HTTP `422` and a message pointing at
`POST /transactions/simulate`, which evaluates a multi-asset transfer against
the spending policies without moving funds.

**Policy violations:** a transaction blocked by a policy is rejected with HTTP
`422` and a `POLICY_VIOLATION` problem-details body that lists every violated
rule, the asset it applies to and the limit that was breached. A blocked
transaction is never persisted and never reaches the blockchain execution
queue.

### POST `/transactions/simulate`
Dry-run the governance pipeline without moving funds.

**Authentication:** Bearer token required

**Request Body:** Either the single-asset body of `POST /transactions` (without
`metadata` being required) or a multi-asset payload:

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| walletId | string | Yes | Valid UUID | Sender wallet ID |
| agentId | string | No | Valid UUID | Initiating agent ID |
| budgetId | string | No | Valid UUID | Budget to charge against |
| asset | string | No | `CODE` or `CODE:ISSUER` | Asset of a single-asset payload |
| amount | string | No | Positive decimal, max 7 decimal places | Amount of a single-asset payload |
| transfers | array | No | 1-10 legs | Multi-asset payload: one `{ asset, amount }` leg per asset. Mutually exclusive with `asset`/`amount` |
| recipientAddress | string | Yes | Non-empty | Stellar destination address |
| memo | string | No | Max 28 chars | Transaction memo |
| purpose | string | No | Max 280 chars | Transaction purpose |
| metadata | object | No | Arbitrary JSON | Additional metadata |

**Response:** Simulation result with policy evaluation, the evaluated
`transfers` and the risk assessment of the riskiest leg

### GET `/transactions/:id`
Get a specific transaction.

**Authentication:** Bearer token required

**Response:** Transaction details

### POST `/transactions/:id/cancel`
Cancel a draft or pending transaction.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Response:** Updated transaction with CANCELLED status

---

## Policy Endpoints (`/policies`)

### GET `/policies`
List policies for the organization.

**Query Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| offset | number | No | Rows to skip (default: 0); mutually exclusive with `page` |
| page | number | No | Page number, alternative to `offset` (default: 1) |
| limit | number | No | Items per page (default: 50, max: 200) |

**Authentication:** Bearer token required

**Response:** Paginated list of policies

### POST `/policies`
Create a policy.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| name | string | Yes | 1-120 chars | Policy name |
| description | string | No | Max 500 chars | Policy description |
| type | enum | Yes | SPENDING_LIMIT, ASSET_RESTRICTION, APPROVAL_WORKFLOW, TIME_WINDOW, EMERGENCY_LOCK | Policy type |
| agentId | string | No | Valid UUID | Scope policy to specific agent |
| configuration | object | No | Valid policy configuration | Policy-specific settings (see below) |
| priority | number | No | 0-1000 | Evaluation priority (default: 100) |
| enabled | boolean | No | - | Policy active state (default: true) |

**Configuration Schema:**
| Field | Type | Description |
|-------|------|-------------|
| maxAmount | number | Maximum single transaction amount |
| minAmount | number | Minimum single transaction amount |
| allowedAssets | string[] | List of allowed asset codes |
| blockedAssets | string[] | List of blocked asset codes |
| allowedRecipients | string[] | List of allowed recipient addresses |
| blockedRecipients | string[] | List of blocked recipient addresses |
| dailyLimit | number | Daily spending limit |
| weeklyLimit | number | Weekly spending limit |
| monthlyLimit | number | Monthly spending limit |
| timeWindow | object | Allowed time window (startHour, endHour, days) |
| requiresApproval | boolean | Whether approval is required |
| approvalThreshold | number | Amount threshold for approval |
| emergencyLock | boolean | Emergency lock flag (blocks all spending) |
| assetLimits | object | Per-asset limit overrides keyed by the upper-case asset code (e.g. `{ "USDC": { "maxAmount": 1000, "dailyLimit": 5000 } }`). An issued asset (`USDC:GA5Z…`) matches the `USDC` entry |
| baseCurrency | string | Currency the amount limits are denominated in (e.g. `USD`). Transfer amounts — and the spend already accumulated for the asset — are converted into that currency before the limits are applied. A missing or stale price rejects the transaction with `PRICE_UNAVAILABLE` (HTTP 503) instead of skipping the limit |

**Response:** Created policy object

### POST `/policies/simulate`
Simulate a transaction intent against active policies.

**Authentication:** Bearer token required

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| agentId | string | No | Valid UUID | Agent ID |
| walletId | string | No | Valid UUID | Wallet ID |
| asset | string | No | `CODE` or `CODE:ISSUER` | Asset of a single-asset payload |
| amount | number | No | Positive | Amount of a single-asset payload |
| transfers | array | No | 1-10 legs | Multi-asset payload: one `{ asset, amount }` leg per asset. Mutually exclusive with `asset`/`amount` |
| recipientAddress | string | Yes | Non-empty | Destination address |
| spentToday | number | No | Non-negative | Amount spent today |
| spentThisWeek | number | No | Non-negative | Amount spent this week |
| spentThisMonth | number | No | Non-negative | Amount spent this month |

**Response:** Policy evaluation result

### GET `/policies/:id`
Get a specific policy.

**Authentication:** Bearer token required

**Response:** Policy details

### PATCH `/policies/:id`
Update a policy.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Request Body:** Partial update of POST `/policies` body

**Response:** Updated policy object

### DELETE `/policies/:id`
Delete (soft-delete) a policy.

**Authentication:** Requires roles: OWNER, ADMIN

**Response:** Success message

---

## Budget Endpoints (`/budgets`)

### GET `/budgets`
List budgets for the organization.

**Query Parameters:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| offset | number | No | Rows to skip (default: 0); mutually exclusive with `page` |
| page | number | No | Page number, alternative to `offset` (default: 1) |
| limit | number | No | Items per page (default: 50, max: 200) |

**Authentication:** Bearer token required

**Response:** Paginated list of budgets

### POST `/budgets`
Create a budget.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| name | string | Yes | 1-120 chars | Budget name |
| period | enum | Yes | DAILY, WEEKLY, MONTHLY | Budget period |
| limit | number | Yes | Positive | Budget limit amount |
| asset | string | Yes | 1-24 chars | Asset code |
| walletId | string | No | Valid UUID | Associated wallet |
| agentId | string | No | Valid UUID | Associated agent |
| resetDate | date | No | Valid date | Custom reset date |

**Response:** Created budget object

### GET `/budgets/:id`
Get a specific budget.

**Authentication:** Bearer token required

**Response:** Budget details with current usage

### PATCH `/budgets/:id`
Update a budget.

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE

**Request Body:** Partial update of POST `/budgets` body

**Response:** Updated budget object

### DELETE `/budgets/:id`
Delete a budget.

**Authentication:** Requires roles: OWNER, ADMIN

**Response:** Success message

---

## Request Correlation

Every response includes the selected request ID in the `x-request-id` header and the standard response envelope. A caller-supplied ID is accepted only when it is 1-128 ASCII characters, starts with a letter or digit, and otherwise contains only letters, digits, `.`, `_`, `:`, or `-`. Invalid values are replaced with a server-generated UUID. The selected ID is propagated as typed event/job metadata and is isolated per concurrent request.

## Audit History (`/audit`)

### GET `/audit`
List audit records in reverse chronological order using a stable `(createdAt, id)` keyset.

**Query Parameters:** `limit` defaults to 20 and is bounded to 1-100; `cursor` is the opaque `nextCursor` from the previous response; optional `actorId`, `action`, `resourceId`, `from`, and `to` filters apply within the authenticated organization. `from` and `to` are inclusive ISO 8601 timestamps and `from` must not be later than `to`.

The response `meta` includes `limit`, `hasNext`, and `nextCursor` (null on the final page). New records inserted after a page is read do not shift subsequent pages.

**Example:** `GET /audit?limit=20&actorId=user-123&action=wallet.created`

### Audit archival

Audit records older than `AUDIT_ARCHIVE_RETENTION_DAYS` (default 30) are moved
out of the actively queried `audit_logs` table into a compressed archive
(`audit_log_archives`) by a scheduled background job. The archive keeps the
full row content, a SHA-256 checksum and the hash-chain anchor of the batch,
so the audit history is preserved while the hot table — and every query
against it — stays small.

- The job runs hourly, processes at most `AUDIT_ARCHIVE_BATCH_SIZE` records
  (default 500) per organization and batch and at most
  `AUDIT_ARCHIVE_MAX_BATCHES` (default 20) batches per run.
- A batch is written and read back (checksum and record count verified)
  *before* the source rows are removed. A failure in between leaves the
  records in place and the job is retried with the shared queue backoff.
- The batch id is derived from the archived row ids, so a retried run reuses
  the existing archive instead of writing a duplicate.
- Because the oldest rows are archived first, the archived rows of an
  organization are always a prefix of its hash chain. `GET
  /audit/integrity/verify` anchors the live rows on the archived prefix and
  keeps reporting a valid chain across the archive boundary.
- The hard-delete retention of the cleanup job (`AUDIT_RETENTION_DAYS`,
  default 90) stays above the archive cutoff, so records are always archived
  before they are deleted. The configuration is validated at startup.

### GET `/audit/archives`
Lists the archive batches of the organization, newest first. Only the batch
metadata is returned — the compressed payload is fetched one batch at a time.

**Query Parameters:** `limit` defaults to 50 and is bounded to 1-100.

**Example:** `GET /audit/archives?limit=10`

### GET `/audit/archives/{batchId}`
Returns the audit records of one archived batch. The compressed payload is
decompressed and its checksum verified before it is returned, so a corrupted
archive answers with an error instead of silently mangled records. A batch of
another organization is reported as `404`.

**Example:** `GET /audit/archives/8f1c3d…`

### GET `/audit/archives`
List the archive batches of the organization, newest first. Only the batch
metadata is returned (batch id, cutoff, record count, checksum, chain anchor);
the compressed payloads are not loaded.

**Authentication:** Requires roles: OWNER, ADMIN, AUDITOR

**Query Parameters:** `limit` defaults to 50 and is bounded to 1-100.

### GET `/audit/archives/:batchId`
Read the audit records of one archived batch. The payload is decompressed and
its checksum verified before it is returned, so a corrupted archive surfaces as
an error instead of as silently mangled audit records. A batch of another
organization is reported as `404`.

**Authentication:** Requires roles: OWNER, ADMIN, AUDITOR

## Outbound Webhook Signatures

Webhook creation and secret rotation responses disclose the signing secret once. Later list, get, update, delivery, and audit responses never include it. Store the secret securely and rotate it when compromised.

Every delivery includes `x-astroid-signature`, `x-astroid-signature-version`, `x-astroid-timestamp`, and `x-astroid-event-id`. `x-astroid-delivery` remains an alias for the event ID. The signature header is `v1=<lowercase hex HMAC-SHA256>` and the version header is `v1`.

The canonical signed bytes are UTF-8 `v1.<timestamp>.<event-id>.` followed by the exact raw HTTP body bytes. Each retry uses the same event ID and body, with a fresh timestamp and signature. Consumers should also reject timestamps outside their chosen replay window.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyAstroidWebhook({ secret, headers, rawBody }) {
  const version = headers['x-astroid-signature-version'];
  const timestamp = headers['x-astroid-timestamp'];
  const eventId = headers['x-astroid-event-id'];
  const received = headers['x-astroid-signature'];
  if (version !== 'v1' || !/^\d{1,12}$/.test(timestamp) || !eventId) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const prefix = Buffer.from(`v1.${timestamp}.${eventId}.`, 'utf8');
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([prefix, rawBody]))
    .digest();
  const match = /^v1=([0-9a-f]{64})$/.exec(received);
  if (!match) return false;
  const actual = Buffer.from(match[1], 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

### Delivery retries and failures

Outgoing deliveries are asynchronous and provide **at-least-once**, not
exactly-once, semantics. The event ID remains stable across retries; consumers
should use it as an idempotency key. By default, BullMQ makes five total
attempts with exponential backoff starting at 2 seconds and 20% jitter. Operators
can configure the attempt limit, base delay, HTTP timeout, and failed-job
retention with `WEBHOOK_DELIVERY_MAX_ATTEMPTS`, `WEBHOOK_RETRY_DELAY_MS`,
`WEBHOOK_HTTP_TIMEOUT_MS`, and `WEBHOOK_FAILED_JOB_RETENTION_SECONDS`.

Network errors, timeouts, HTTP 408, HTTP 429, and 5xx responses are retried.
Other 3xx/4xx responses are treated as permanent and stop immediately. Redirects
are not followed. Exhausted jobs are routed to the shared dead-letter queue and
recorded in the webhook delivery audit trail. Failed BullMQ jobs are retained
for 24 hours by default; the dead-letter queue retains failed records for seven
days by default. `WEBHOOK_DEAD_LETTER_RETENTION_SECONDS` configures that
retention. Operators can inspect and re-drive dead-letter jobs through the
existing queue administration tools.

### Inbound signature verification

`POST /{API_PREFIX}/webhooks/receive` requires both
`x-astroid-timestamp` and `x-astroid-signature`. The inbound signature is the
lowercase 64-character hex HMAC-SHA256 digest of UTF-8
`<timestamp>.` concatenated with the exact raw request body bytes. The request
timestamp must be within five minutes of server time. Verification uses a
constant-time comparison; missing, malformed, stale, or invalid signatures are
rejected before the ingress handler runs.

The route uses the dedicated `WEBHOOK_INGRESS_SECRET`, which must contain at
least 32 characters. It is separate from each outbound subscription's
`whsec_...` secret; when unset, inbound requests are rejected. Deployments
should provide it through a secret manager. Nest captures raw request bytes
before JSON parsing so whitespace and key order are preserved for verification.

## Health Probes (`/health`)

The liveness and readiness probes are served **outside** the API prefix, so
orchestrator and load-balancer probe paths do not change with the API version.
Both are public, exempt from rate limiting, excluded from the audit trail, and
return raw JSON (no success envelope).

### GET `/health/live`
Liveness probe. Returns `200` whenever the process is running. It performs no
dependency checks, so a database or cache outage never causes an otherwise
healthy process to be restarted.

**Authentication:** Public

**Response (200):**
```json
{ "status": "up", "timestamp": "2026-09-28T10:00:00.000Z", "uptimeSeconds": 42 }
```

### GET `/health/ready`
Readiness probe. Probes the database (`SELECT 1`) and cache (Redis `PING`) in
parallel, each bounded by a 2 second timeout. Returns `200` when every
dependency is up and `503` when any is down.

**Authentication:** Public

**Response (503 example):**
```json
{
  "status": "down",
  "timestamp": "2026-09-28T10:00:00.000Z",
  "services": {
    "database": {
      "status": "down",
      "latencyMs": 2001,
      "timestamp": "2026-09-28T10:00:00.000Z",
      "error": "Database health check timed out after 2000ms"
    },
    "cache": { "status": "up", "latencyMs": 1, "timestamp": "2026-09-28T10:00:00.000Z" }
  }
}
```

Richer diagnostics (including Stellar and migration status) remain available
under the API prefix at `GET /{API_PREFIX}/health/readiness`,
`GET /{API_PREFIX}/health/liveness` and `GET /{API_PREFIX}/health/database`.

### GET `/{API_PREFIX}/health/stellar`
Stellar network connectivity check. Probes the configured Horizon server and
the Soroban RPC node in parallel, each bounded by a 2 second timeout. Returns
`200` when both endpoints are healthy and `503` when one of them is `down` or
`degraded` — an endpoint that answers but needs more than half of the budget is
reported as `degraded`.

**Authentication:** Public

**Response (503 example):**
```json
{
  "status": "down",
  "timestamp": "2026-09-28T10:00:00.000Z",
  "network": "testnet",
  "horizon": { "status": "up", "latencyMs": 42, "url": "https://horizon-testnet.stellar.org" },
  "sorobanRpc": {
    "status": "down",
    "latencyMs": 2001,
    "url": "https://soroban-testnet.stellar.org",
    "error": "The operation was aborted"
  }
}
```

### GET `/{API_PREFIX}/health/redis`
Redis connectivity check. Issues a `PING` on the application's shared Redis
client, bounded by a 2 second timeout, so the check exercises the exact
connection the API depends on. Returns `200` when the ping is answered and
`503` when Redis is unreachable or the probe times out.

**Authentication:** Public

---

## Common Types

### Pagination Query
Every list endpoint accepts the same query parameters.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| offset | number | 0 | Zero-based number of rows to skip. Mutually exclusive with `page` |
| page | number | 1 | 1-based page number, an alternative to `offset` |
| limit | number | 50 | Items per page, capped at 200 |
| sort | string | createdAt | Sort field (restricted to an allow-list per endpoint) |
| order | `asc` \| `desc` | desc | Sort direction |

Negative, non-integer or non-numeric values, a `limit` above 200, or supplying both `offset` and `page` return `400 Bad Request`.

Paginated responses carry the total row count in the `X-Total-Count` header and in `meta`:
```json
{
  "success": true,
  "data": [],
  "meta": { "offset": 50, "page": 2, "limit": 50, "total": 120, "totalPages": 3, "hasNext": true, "hasPrev": true },
  "requestId": "req_..."
}
```

### Error Response
All endpoints return errors as [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details with `Content-Type: application/problem+json`:
```json
{
  "type": "urn:astroid:problem:validation-error",
  "title": "Validation Failed",
  "status": 400,
  "detail": "Request validation failed",
  "instance": "/api/v1/agents",
  "code": "VALIDATION_ERROR",
  "requestId": "req_018f...",
  "details": [{ "path": "limit", "message": "Number must be less than or equal to 200" }]
}
```

| Member | Description |
|--------|-------------|
| `type` | URI identifying the problem type (`urn:astroid:problem:<code>`), or `about:blank` for plain HTTP errors without a dedicated code (e.g. 405) |
| `title` | Short summary of the problem type; the same for every occurrence |
| `status` | HTTP status code |
| `detail` | Explanation specific to this occurrence |
| `instance` | Request path that produced the error (query string omitted) |
| `code` | Machine-readable error code; clients should switch on this rather than on `title` or `detail` |
| `requestId` | Correlation id, matching the `x-request-id` header |
| `details` | Optional structured context, e.g. field-level validation errors |

Unhandled server errors always return `500` with `code: "INTERNAL_ERROR"` and a generic `detail`; internal information is only written to the server logs under the `requestId`. Stack traces are never included in a response.

The same envelope is used for requests rejected before they reach a controller — a malformed JSON body returns `400`, and a body above the parser limit returns `413` — so clients only ever parse one error shape.

A transaction that is blocked by a spending policy returns `422` with
`code: "POLICY_VIOLATION"`. The `details.violations` array lists every
violated rule with its `policyId`, `policyName`, `code`, `message` and the
`asset` the rule applies to:

```json
{
  "type": "urn:astroid:problem:policy-violation",
  "title": "Policy Violation",
  "status": 422,
  "code": "POLICY_VIOLATION",
  "detail": "Transaction blocked by spending limit policy: USDC cap: Projected daily spend 600 USDC exceeds limit 500 USDC",
  "details": {
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
}
```

When a policy denominates its limits in a base currency and no usable price is
available, the transaction is rejected with `503` and
`code: "PRICE_UNAVAILABLE"` instead of being let through with an unknown
price.

### Authentication
Most endpoints require Bearer token authentication in the format:
```
Authorization: Bearer <access_token>
```

Tokens are obtained via `/auth/login` or `/auth/register` endpoints.

### Public Endpoint Rate Limiting
Unauthenticated endpoints (routes marked `@Public()`, such as `/auth/login`, `/auth/register` and `/auth/refresh`, and every route under `/public/`) share a per-IP sliding-window budget: 60 requests per 60 seconds by default, configurable with `PUBLIC_RATE_LIMIT_MAX_REQUESTS` and `PUBLIC_RATE_LIMIT_WINDOW_SECONDS`. Counters are stored in Redis, so the budget applies across all API instances.

Every rate-limited response includes:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Requests allowed per window |
| `X-RateLimit-Remaining` | Requests left in the current window |
| `X-RateLimit-Reset` | Unix time (seconds) at which the next request slot frees up |

When the budget is exhausted the API responds with `429 Too Many Requests`, a `Retry-After` header (seconds) and error code `RATE_LIMITED`. These limits are in addition to the per-route auth throttling on the `/auth` endpoints.
