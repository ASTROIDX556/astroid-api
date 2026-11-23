# Astroid API Documentation Reference

## Authentication Endpoints (`/auth`)

### POST `/auth/register`
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
| limit | number | No | Items per page (default: 20, max: 100) |
| cursor | string | No | Opaque cursor from the previous response meta.nextCursor |

**Authentication:** Bearer token required

**Response:** Paginated list of wallets

### POST `/wallets`
Create a wallet (generate a keypair or import an address).

**Authentication:** Requires roles: OWNER, ADMIN, FINANCE, DEVELOPER

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| label | string | No | Max 120 chars | Wallet label/name |
| walletType | enum | No | AGENT, OPERATIONAL, TREASURY | Type of wallet (default: AGENT) |
| network | enum | No | TESTNET, PUBLIC | Stellar network (default: TESTNET) |
| agentId | string | No | Valid UUID | Owning agent ID |
| stellarAddress | string | No | Non-empty | Import existing address (if provided, no keypair is generated) |

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
| label | string | No | Max 120 chars | New wallet label |
| agentId | string | No | Valid UUID or null | Reassign or clear owning agent |

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
| limit | number | No | Items per page (default: 20, max: 100) |
| cursor | string | No | Opaque cursor from the previous response meta.nextCursor |

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
| asset | string | No | 1-24 chars | Asset code (default: XLM) |
| amount | string | Yes | Positive decimal, max 7 decimal places | Transaction amount |
| recipientAddress | string | Yes | Non-empty | Stellar destination address |
| memo | string | No | Max 28 chars | Transaction memo |
| purpose | string | No | Max 280 chars | Transaction purpose |
| metadata | object | No | Arbitrary JSON | Additional metadata |

**Response:** Transaction object with governance evaluation result

### POST `/transactions/simulate`
Dry-run the governance pipeline without moving funds.

**Authentication:** Bearer token required

**Request Body:** Same as POST `/transactions`

**Response:** Simulation result with policy evaluation

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
| limit | number | No | Items per page (default: 20, max: 100) |
| cursor | string | No | Opaque cursor from the previous response meta.nextCursor |

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

**Response:** Created policy object

### POST `/policies/simulate`
Simulate a transaction intent against active policies.

**Authentication:** Bearer token required

**Request Body:**
| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| agentId | string | No | Valid UUID | Agent ID |
| walletId | string | No | Valid UUID | Wallet ID |
| asset | string | Yes | Non-empty | Asset code |
| amount | number | Yes | Positive | Transaction amount |
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
| limit | number | No | Items per page (default: 20, max: 100) |
| cursor | string | No | Opaque cursor from the previous response meta.nextCursor |

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

## Common Types

### Pagination Query

Every list endpoint returns a growing collection using **cursor pagination**
with deterministic `(createdAt DESC, id DESC)` ordering.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| limit | number | 20 | Items per page (max 100) |
| cursor | string | — | Opaque cursor from `meta.nextCursor` of the previous page |
| search | string | — | Optional free-text filter, where supported |
| filter | string | — | Optional field filter, where supported |

**Response meta:**

```json
{
  "success": true,
  "data": [],
  "meta": {
    "limit": 20,
    "total": 137,
    "page": 1,
    "totalPages": 7,
    "hasNext": true,
    "hasPrev": false,
    "nextCursor": "eyJ2IjoxLCJvIjoiY3JlYXRlZEF0OmlkOmRlc2MiLCJ0Ijoi..."
  },
  "requestId": "req_..."
}
```

`meta.nextCursor` is `null` on the final page. Offset paging (`page`) is no
longer accepted: pass `cursor` to walk the feed. Cursors are opaque and
ordering-bound — a malformed, tampered or stale cursor returns **400
`INVALID_CURSOR`** rather than silently skipping or repeating rows. Inserting
rows mid-walk cannot shift a subsequent page.

The legacy `page`, `totalPages`, `hasNext` and `hasPrev` meta fields are still
present for compatibility; `page` is always `1` because pages are
position-based.

### Error Response
All endpoints return errors in a consistent format:
```json
{
  "statusCode": number,
  "message": string,
  "error": string
}
```

### Authentication
Most endpoints require Bearer token authentication in the format:
```
Authorization: Bearer <access_token>
```

Tokens are obtained via `/auth/login` or `/auth/register` endpoints.

---

## API Key Endpoints (`/developer/api-keys`)

API keys are hashed before storage; the raw secret is returned **exactly once**
on create or rotate.

### Scope model

A key carries a set of scopes. A route annotated with required scopes rejects a
key that lacks them with **403 Forbidden** (`FORBIDDEN`); a revoked or expired
key is rejected with **401 Unauthorized**. JWT-authenticated human sessions are
unaffected by scopes and keep their role-based permissions.

Allowed scopes:

| Scope | Grants |
|-------|--------|
| `wallet:read` | Read wallets and balances |
| `wallet:write` | Create, update, freeze wallets |
| `transaction:read` | Read transactions |
| `transaction:create` | Create and execute transactions |
| `policy:read` | Read spending policies |
| `policy:write` | Create, update, delete spending policies |
| `budget:read` | Read budgets |
| `budget:write` | Create, update, allocate budgets |
| `approval:write` | Decide approval proposals |
| `webhook:read` | Read webhooks and delivery logs |
| `webhook:manage` | Create, update, rotate, delete webhooks |
| `audit:read` | Read/export the audit trail |
| `api_key:manage` | Create, rotate, update, revoke API keys |

Unknown scope strings are rejected at creation/update with **400 Bad Request**;
the error `details.allowed` lists the full allowed set.

**Backward compatibility:** keys created before scopes existed have an empty
scope set and retain full access. New keys created without `scopes` are
unrestricted by the same rule; pass an explicit list to restrict a key.
Existing keys should be migrated by setting an explicit scope list via `PATCH`.

### POST `/developer/api-keys`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Key label (1-120 chars) |
| scopes | string[] | No | Allowed scope strings (see table) |
| allowedIps | string[] | No | IP/CIDR allow-list |
| expiresInDays | number | No | Expiry in days (max 365) |

**Response:** `{ id, name, prefix, scopes, permissions, expiresAt, key }` — `key`
is the only time the secret is returned.

### PATCH `/developer/api-keys/:id`
Update `name`, `scopes` and/or `allowedIps`. The secret is never editable.

### POST `/developer/api-keys/:id/rotate`
Rotate the secret, preserving scopes and settings. Returns the new `key` once.

### DELETE `/developer/api-keys/:id`
Revoke a key. Subsequent use fails with 401.

---

## Webhook Delivery (`/webhooks`)

### `GET /webhooks/deliveries`

Lists delivery attempts (cursor paginated). Filters:

| Field | Type | Description |
|-------|------|-------------|
| webhookId | string | Only deliveries for one webhook |
| status | enum | `PENDING`, `RETRYING`, `FAILED`, `DELIVERED`, `FAILED_PERMANENTLY` |
| limit / cursor | — | Cursor pagination as described above |

Each row exposes `attempts`, `lastStatusCode`, `lastAttemptAt`,
`nextAttemptAt`, `lastError` and `deadLetteredAt`. Filter with
`status=FAILED_PERMANENTLY` to read the dead-letter queue.

### Retry policy

- Retries on network errors, timeouts, `408`, `429` and `5xx`.
- Never retries other `4xx` (e.g. `400`, `404`); the delivery fails permanently
  immediately.
- Backoff is capped and jittered: `30s → 1m → 5m → 15m → 30m` (± 20% jitter).
- Maximum 6 attempts by default; after the last attempt the delivery is marked
  `FAILED_PERMANENTLY` and copied to the `webhook-dead-letter` queue.
- Configurable via `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_TIMEOUT_MS`,
  `WEBHOOK_BACKOFF_DELAYS_MS` and `WEBHOOK_BACKOFF_JITTER_RATIO`.
- HMAC signing (`x-astroid-signature`), `x-astroid-event` and
  `x-astroid-event-id` headers are unchanged.

---

## Governance Audit Events

Governance mutations emit typed audit events after the database write succeeds;
failed mutations emit nothing. The audit listener persists actor, resource type,
resource id, action, before/after snapshots and the originating `x-request-id`.

| Mutation | Event | Audit action |
|----------|-------|--------------|
| Spending policy create / update / delete | `policy.created` / `policy.updated` / `policy.deleted` | `policy.*` |
| Budget create / update / delete | `budget.created` / `budget.updated` / `budget.deleted` | `budget.*` |
| Approval decision | `approval.decided` | `approval.decided` |
| API key create / update / rotate / revoke | `api_key.created` / `api_key.updated` / `api_key.rotated` / `api_key.revoked` | `api_key.*` |
