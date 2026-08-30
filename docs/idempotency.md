# Idempotency for State-Mutating Transaction Endpoints

This document proposes an implementation approach for GitHub issue #83.
It does not implement the interceptor. It documents how idempotency
could be introduced into the existing transaction flow while preventing
duplicate state-changing operations.

---

## Current Implementation

### Architecture

The Astroid API is a NestJS application using:

- **Prisma** (PostgreSQL) as the persistence layer
- **Redis** (ioredis) for distributed locking and queue infrastructure
- **BullMQ** for background job processing
- A standard request/response envelope (`{ success, data, meta, requestId }`)
- Global interceptors registered via `APP_INTERCEPTOR` in `src/app.module.ts`

### Existing Interceptors

Three interceptors are registered globally in `src/app.module.ts:121-123`:

1. **AgentTraceInterceptor** (`src/common/interceptors/agent-trace.interceptor.ts`) — binds trace context to `AsyncLocalStorage`
2. **ResponseInterceptor** (`src/common/interceptors/response.interceptor.ts`) — wraps return values in the success envelope
3. **AuditInterceptor** (`src/common/interceptors/audit.interceptor.ts`) — persists audit-log records for state-mutating HTTP requests

### State-Mutating Transaction Endpoints

The following endpoints perform state changes that idempotency should protect:

| Controller | Method | Route | Service Method | State Changed |
|---|---|---|---|---|
| `TransactionController` | `POST` | `/transactions` | `TransactionService.create()` | Persists a `Transaction` row; may execute a Stellar payment |
| `TransactionController` | `POST` | `/transactions/:id/cancel` | `TransactionService.cancel()` | Changes `Transaction.status` to `CANCELLED` |
| `ApprovalController` | `POST` | `/proposals/:id/decision` | `ApprovalService.decide()` | Records an `Approval` vote; may trigger `TransactionService.execute()` |
| `ApprovalController` | `POST` | `/proposals/:id/approve` | `ApprovalService.decide()` | Alias for `decision` with `APPROVED` |
| `ApprovalController` | `POST` | `/proposals/:id/reject` | `ApprovalService.decide()` | Alias for `decision` with `REJECTED` |

**Endpoints that should NOT use idempotency:**

- `GET /transactions` — read-only list
- `GET /transactions/:id` — read-only fetch
- `POST /transactions/simulate` — dry-run, no state mutation
- `GET /proposals` — read-only list
- `GET /proposals/:id` — read-only fetch

### Existing Partial Idempotency

`TransactionService.execute()` (`src/modules/transactions/transaction.service.ts:155-214`) already performs a status check before submitting on-chain:

```typescript
if (
  tx.status === TransactionStatus.COMPLETED ||
  tx.status === TransactionStatus.SUBMITTED ||
  tx.status === TransactionStatus.CONFIRMED
) {
  throw new ConflictException(`Transaction '${transactionId}' has already been executed`);
}
```

This prevents duplicate Stellar submission within a single process, but it does not address:

- Concurrent duplicate API requests arriving before the first completes
- Duplicate `POST /transactions` creating two distinct `Transaction` rows with identical intent
- Duplicate `POST /proposals/:id/decision` votes (partially addressed by a unique-vote check in `ApprovalService`)

### Existing Infrastructure

- **Header constant**: `IDEMPOTENCY_KEY_HEADER = 'idempotency-key'` is already defined in `src/common/constants/headers.ts:8`
- **Redis**: Redis is configured via `src/config/redis.config.ts` and used by `RedisLock` (`src/common/locks/redis-lock.util.ts`) with `SET NX EX` for distributed locking
- **Error codes**: `ErrorCode.CONFLICT` maps to HTTP 409 (`src/common/constants/error-codes.ts:10,48`)
- **Domain exceptions**: `ConflictException` wraps `ErrorCode.CONFLICT` (`src/common/exceptions/domain.exception.ts:32-36`)

---

## Problem Statement

Consider this scenario with `POST /transactions`:

1. Client sends `POST /transactions` with `Idempotency-Key: abc123`
2. The server begins processing: validates the wallet, evaluates policies, scores risk
3. The server persists a `Transaction` row and submits the Stellar payment
4. The network is slow; the client times out and retries with the same key
5. Without idempotency, the server may create a second `Transaction` row and submit a duplicate Stellar payment

The existing status check in `execute()` helps for the specific execute path, but the `create()` method has no protection against duplicate row creation. Two concurrent `POST /transactions` requests with identical payloads can produce two separate `Transaction` records.

Similarly, `POST /proposals/:id/decision` has a per-user vote deduplication (`ApprovalService.decide()` checks `findApprovalByUser`), but a retry of the same decision from the same user could race past that check.

---

## Proposed Idempotency-Key Behavior

### Missing Key

**Proposal**: If a state-mutating transaction endpoint does not include an `Idempotency-Key` header, the request should proceed normally without idempotency tracking.

**Rationale**: Making the key mandatory would break existing clients and SDKs. Idempotency is opt-in. Clients that want duplicate protection add the header; clients that do not care (e.g., idempotent retries of read operations) omit it.

If the maintainer prefers a stricter contract, an alternative is to reject with `400 Bad Request` using `ErrorCode.BAD_REQUEST` for state-mutating endpoints that lack the header. This should be a conscious API design decision.

### First Request

```
Client
  |
  v
Idempotency-Key header extracted by IdempotencyInterceptor
  |
  v
Calculate request fingerprint (hash of method + path + body)
  |
  v
Atomic key reservation in Postgres (INSERT ... ON CONFLICT DO NOTHING)
  |
  v
No existing record found
  |
  v
Reserve key with status PROCESSING
  |
  v
Execute controller handler (TransactionService.create, etc.)
  |
  v
Persist result: status -> COMPLETED, store response body
  |
  v
Return response to client
```

### Duplicate Request After Completion

```
Client
  |
  v
Idempotency-Key header extracted
  |
  v
Lookup key in idempotency_records
  |
  v
Status is COMPLETED
  |
  v
Return stored response body without executing handler
```

The client receives the exact same response (status code, body) as the first request.

### Duplicate Request While Processing

```
Request A -> key ABC -> PROCESSING (in flight)
Request B -> key ABC -> arrives while A is still running
```

**Proposal**: Return `409 Conflict` with `ErrorCode.CONFLICT` and a message like `"A request with this idempotency key is currently being processed"`.

**Rationale**: The client does not know whether the first request succeeded or failed. Returning `409` signals the conflict without guessing. The client should wait and retry (with backoff) or query the resource to determine the outcome. This is simpler than implementing a wait/queue mechanism and avoids blocking HTTP connections.

Alternative considered: returning `202 Accepted` with a "processing" status. This would require the client to poll for completion, adding complexity. The `409` approach is simpler and consistent with the existing `ConflictException` pattern.

### Duplicate Request with Different Payload

```
Request A -> key ABC, body: { amount: "100", recipient: "G..." }
Request B -> key ABC, body: { amount: "500", recipient: "G..." }
```

**Proposal**: Return `409 Conflict` with message `"Idempotency key reuse with a different request payload is not allowed"`.

**Rationale**: Silently treating different payloads under the same key as identical would mask client bugs and could lead to financial errors (sending 500 when the client intended 100).

---

## Request Fingerprinting

The implementation should store a deterministic hash of the request alongside the idempotency key. This enables payload mismatch detection.

### Fingerprint components

```
fingerprint = SHA-256(
  HTTP method + "\n" +
  request path + "\n" +
  sorted canonical body JSON
)
```

Using method + path + body ensures that:

- `POST /transactions` and `POST /proposals/:id/decision` with the same body produce different fingerprints
- Different payloads under the same key produce different fingerprints

The fingerprint is computed from the raw request body before any transformation (Zod validation, pipe processing). This avoids issues with default values or field ordering affecting the hash.

### Storage

The `idempotency_records` table (see Persistence Design) stores:

```
key              TEXT PRIMARY KEY
request_fingerprint TEXT NOT NULL
status           TEXT NOT NULL  -- PROCESSING | COMPLETED | FAILED
response_status  INT            -- HTTP status code of stored response
response_body    JSONB          -- serialized response body
transaction_id   TEXT            -- reference to created Transaction row (if applicable)
organization_id  TEXT NOT NULL   -- for scoping and cleanup
created_at       TIMESTAMPTZ NOT NULL
updated_at       TIMESTAMPTZ NOT NULL
expires_at       TIMESTAMPTZ NOT NULL  -- for automatic cleanup
```

---

## Persistence Design

### Why PostgreSQL (not Redis)

The repository already uses Prisma with PostgreSQL. The `IdempotencyKey` header constant and `RedisLock` utility exist, but Redis is primarily used for:

- Distributed locking (`RedisLock` in `src/common/locks/redis-lock.util.ts`)
- BullMQ job queues (`@nestjs/bullmq`)
- Rate limiting configuration

PostgreSQL is the better choice here because:

1. **Atomic INSERT**: Prisma's `create` with `@@unique` or a raw `INSERT ... ON CONFLICT DO NOTHING` provides the atomic reservation needed without an extra Redis dependency
2. **Transactional consistency**: Idempotency records can be created in the same Prisma transaction as the `Transaction` row, ensuring they are always in sync
3. **Queryability**: `expires_at` cleanup can use a simple `DELETE WHERE expires_at < now()` scheduled job (the repo already uses `@nestjs/schedule`)
4. **No data loss risk**: Redis is volatile; a restart could lose in-flight idempotency records, causing duplicate execution on retry

### Proposed Prisma model

Add to `prisma/schema.prisma`:

```prisma
model IdempotencyRecord {
  id                String   @id @default(uuid(7))
  key               String   @unique
  requestFingerprint String
  organizationId    String
  status            String   @default("PROCESSING") // PROCESSING | COMPLETED | FAILED
  responseStatus    Int?
  responseBody      Json?
  transactionId     String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  expiresAt         DateTime

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@index([expiresAt])
  @@index([status])
  @@map("idempotency_records")
}
```

### Unique constraint

The `key` field has `@unique`. This is the enforcement mechanism: two concurrent requests attempting to INSERT the same key will result in a unique constraint violation on exactly one of them. The first INSERT succeeds; the second fails with a Prisma `P2002` error, which the interceptor catches and translates to a `409 Conflict`.

### Retention / expiration

- `expires_at` defaults to `created_at + 24 hours`
- A scheduled job (using `@nestjs/schedule` which is already a dependency) runs periodically and deletes records where `expires_at < now()`
- This prevents unbounded table growth while retaining keys long enough for client retries

---

## Concurrency and Atomic Reservation

### Why naive check-then-act is insufficient

```typescript
// THIS IS NOT SAFE — do not implement this pattern
const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
if (!existing) {
  await prisma.idempotencyRecord.create({ data: { key, status: 'PROCESSING' } });
  // execute transaction...
}
```

Two concurrent requests can both execute `findUnique` before either executes `create`. Both see no existing record; both proceed to create a row and execute the transaction.

### Correct approach: atomic INSERT

```typescript
try {
  await prisma.idempotencyRecord.create({
    data: {
      key,
      requestFingerprint,
      organizationId,
      status: 'PROCESSING',
      expiresAt: new Date(Date.now() + 24 * 3_600_000),
    },
  });
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    // Key already exists — handle duplicate
    const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
    // ... handle based on existing.status
  }
  throw error;
}
```

The `INSERT` is atomic at the database level. Only one request succeeds; the other gets a `P2002` unique constraint violation. The catching request then reads the existing record and decides what to return based on its status.

### Handling the existing record

After catching `P2002`, the interceptor reads the existing record:

| Record Status | Request Payload | Action |
|---|---|---|
| `COMPLETED` | same fingerprint | Return stored `responseBody` and `responseStatus` |
| `COMPLETED` | different fingerprint | Return `409 Conflict` |
| `PROCESSING` | same fingerprint | Return `409 Conflict` ("request in progress") |
| `PROCESSING` | different fingerprint | Return `409 Conflict` |
| `FAILED` | same fingerprint | Re-execute the handler (retry semantics — see Failure Semantics) |
| `FAILED` | different fingerprint | Return `409 Conflict` |

---

## Failure Semantics

### Validation failure (before execution)

If the controller handler throws a validation error (Zod pipe, `DomainException` with `VALIDATION_ERROR`), the interceptor should:

1. Update the idempotency record to `FAILED`
2. Store the error response in `responseBody`
3. The key is NOT permanently blocked — subsequent retries with the same payload re-execute the handler

This allows clients to fix malformed input and retry with the same key.

### Transaction submission failure

If `TransactionService.execute()` throws (e.g., Stellar network error), the interceptor should:

1. Update the idempotency record to `FAILED`
2. Store the error response
3. The key becomes retryable — a subsequent request with the same key and fingerprint re-executes the handler

This is important because Stellar submission failures are often transient. The client should be able to retry with the same idempotency key.

### Server crash after reservation

If the process crashes after reserving the key (status `PROCESSING`) but before completing, the record remains stuck in `PROCESSING`.

**Proposed recovery mechanism**: The scheduled cleanup job should also handle stale `PROCESSING` records:

- Records in `PROCESSING` for longer than a configurable timeout (e.g., 5 minutes) are reset to `FAILED`
- This allows retries while avoiding permanent key locks
- The timeout should be generous enough to cover the longest expected transaction pipeline execution

Alternative: Use a Redis-based lease (TTL) alongside the Postgres record for faster detection of crashed requests. This is more complex and can be deferred to a later phase.

---

## Blockchain-Specific Considerations

### API acceptance vs blockchain confirmation

The current transaction flow has two distinct phases:

1. **API acceptance**: `TransactionService.create()` persists a `Transaction` row with status `DRAFT`, runs governance checks, and either creates a `Proposal` (requiring approval) or calls `execute()`
2. **Blockchain execution**: `TransactionService.execute()` submits the payment to Stellar and updates the status to `COMPLETED` or `FAILED`

Idempotency should protect both phases:

- **Phase 1** (`POST /transactions`): Prevents duplicate `Transaction` row creation. Two identical requests should produce one `Transaction` record, not two.
- **Phase 2** (triggered by `POST /proposals/:id/decision` reaching approval threshold, or directly from `POST /transactions`): Prevents duplicate Stellar submission. The existing status check in `execute()` partially handles this, but the idempotency interceptor adds a request-level guarantee.

### What idempotency protects

| Scenario | Protected? |
|---|---|
| Duplicate `POST /transactions` creating two Transaction rows | Yes — interceptor prevents duplicate creation |
| Duplicate Stellar payment submission | Yes — interceptor prevents duplicate `execute()` calls; existing status check is a second defense |
| Duplicate approval vote | Yes — interceptor + existing `findApprovalByUser` check |
| Duplicate cancel | Yes — interceptor prevents duplicate cancel |

### Stellar transaction hash

When a `Transaction` is successfully executed, the `stellarHash` is stored on the `Transaction` record. If a duplicate request is served from the idempotency cache, the same `stellarHash` is returned, confirming to the client that the same on-chain transaction was referenced.

---

## NestJS Interceptor Design

### Interceptor location

```
src/common/interceptors/idempotency.interceptor.ts
```

Follows the existing convention of placing interceptors in `src/common/interceptors/`.

### Interceptor structure

```typescript
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // 1. Extract Idempotency-Key header
    const key = req.headers[IDEMPOTENCY_KEY_HEADER] as string | undefined;
    if (!key) {
      return next.handle(); // no key — pass through without idempotency tracking
    }

    // 2. Calculate request fingerprint
    const fingerprint = this.computeFingerprint(req.method, req.path, req.body);

    // 3. Extract organization from authenticated user
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return next.handle(); // no auth context — pass through
    }

    // 4. Atomic key reservation
    // 5. Check existing record
    // 6. Execute handler or return cached response
    // 7. Store result
  }
}
```

### Custom decorator for opt-in application

Rather than applying the interceptor globally, use a custom decorator to mark specific controller methods:

```typescript
// src/common/decorators/idempotent.decorator.ts
import { SetMetadata } from '@nestjs/common';
export const IDEMPOTENT_KEY = 'idempotent';
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
```

Apply to controllers:

```typescript
@Post()
@Idempotent()
@Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.FINANCE, UserRole.DEVELOPER)
create(...) { ... }
```

The interceptor checks for this metadata via `Reflector.getAllAndOverride` (same pattern as `AuditInterceptor` checks `IS_SKIP_AUDIT_KEY`).

### Application scope

The interceptor should be applied to:

- `TransactionController.create` — `POST /transactions`
- `TransactionController.cancel` — `POST /transactions/:id/cancel`
- `ApprovalController.decide` — `POST /proposals/:id/decision`
- `ApprovalController.approve` — `POST /proposals/:id/approve`
- `ApprovalController.reject` — `POST /proposals/:id/reject`

The interceptor should NOT be applied to:

- `TransactionController.simulate` — dry-run, no state mutation
- `TransactionController.list` / `findOne` — read-only
- `ApprovalController.list` / `findOne` — read-only

### Interceptor ordering

The interceptor should run **before** `AuditInterceptor` but **after** `AgentTraceInterceptor` and `ResponseInterceptor`. In the current `APP_INTERCEPTOR` registration order:

```typescript
{ provide: APP_INTERCEPTOR, useClass: AgentTraceInterceptor },  // 1st
{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },     // 2nd
{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor },        // 3rd
```

Add the idempotency interceptor as the first interceptor (before AgentTraceInterceptor):

```typescript
{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }, // 0th — checks key, may short-circuit
{ provide: APP_INTERCEPTOR, useClass: AgentTraceInterceptor },  // 1st
{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },     // 2nd
{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor },        // 3rd
```

This ensures that if a cached response is returned, the audit interceptor still logs the request (including the cache hit).

---

## API Contract

### Headers

| Header | Required | Description |
|---|---|---|
| `Idempotency-Key` | No (opt-in) | A unique string identifying the idempotent operation. Recommended: UUID v7 or similar time-ordered unique value. |

### First request (no prior key)

```http
POST /transactions
Idempotency-Key: 01926c0a-1234-7abc-9def-012345678900
Content-Type: application/json

{
  "walletId": "...",
  "amount": "100",
  "recipientAddress": "G...",
  "asset": "XLM"
}
```

Response (success):

```json
{
  "success": true,
  "data": {
    "transaction": { "id": "...", "status": "COMPLETED", "stellarHash": "...", ... },
    "requiresApproval": false,
    "risk": { ... }
  },
  "meta": {},
  "requestId": "..."
}
```

### Duplicate request (same key, same payload, after completion)

Same `Idempotency-Key` header, same request body. The handler is NOT executed. The stored response from the first request is returned verbatim.

Response: identical to the first request.

### Duplicate request (same key, different payload)

```http
POST /transactions
Idempotency-Key: 01926c0a-1234-7abc-9def-012345678900
Content-Type: application/json

{
  "walletId": "...",
  "amount": "500",
  "recipientAddress": "G..."
}
```

Response:

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Idempotency key reuse with a different request payload is not allowed"
  },
  "requestId": "..."
}
```

HTTP status: `409 Conflict`

### Duplicate request (same key, currently processing)

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "A request with this idempotency key is currently being processed"
  },
  "requestId": "..."
}
```

HTTP status: `409 Conflict`

### Missing key (state-mutating endpoint)

If no `Idempotency-Key` header is present, the request proceeds normally without idempotency tracking. The handler executes as it does today.

---

## Security Considerations

### Key scope

Idempotency keys MUST be scoped to the authenticated `organizationId`. A key used by organization A must not affect organization B. The `organizationId` field on `IdempotencyRecord` enforces this at the database level.

The interceptor extracts `organizationId` from `req.user` (set by `JwtAuthGuard` / `ApiKeyGuard`).

### Key entropy

Keys should be at least 16 characters with high entropy. The implementation should reject keys shorter than 16 characters with `400 Bad Request`. UUID v7 (already used in the codebase via `uuid` package) is recommended.

### Sensitive data in keys

Clients should not embed sensitive data (amounts, addresses, secrets) in the idempotency key. The key is stored in the database and appears in logs. The API documentation should warn against this.

### Request fingerprint integrity

The fingerprint is computed from the raw request body. The implementation must compute it before any body transformation (Zod validation, pipe processing) to ensure determinism.

### Denial of service

Unbounded idempotency record creation could fill the database. Mitigations:

1. **Expiration**: Records auto-expire after 24 hours via `expires_at`
2. **Cleanup job**: Periodic deletion of expired records
3. **Rate limiting**: Existing `ThrottlerGuard` already limits request rate per organization
4. **Optional cap**: Limit active (non-expired) idempotency records per organization

### Response data storage

The stored response body may contain sensitive transaction details. The `responseBody` field should be subject to the same retention/expiration as the key itself. Once the record expires, the response data is deleted.

---

## Testing Strategy

A future implementation should add the following tests:

### Unit tests

**`src/common/interceptors/idempotency.interceptor.spec.ts`**

- First request with key: handler is executed, record is created with `COMPLETED` status
- Duplicate request (same key, same fingerprint, `COMPLETED`): handler is NOT executed, stored response is returned
- Duplicate request (same key, different fingerprint): `409 Conflict` is returned
- Duplicate request (same key, `PROCESSING`): `409 Conflict` is returned
- Duplicate request (same key, `FAILED`, same fingerprint): handler is re-executed (retry)
- No key header: handler executes normally, no record created
- Key too short: `400 Bad Request`
- Fingerprint computation: same body produces same hash; different body produces different hash

### Integration tests

**`src/modules/transactions/transaction.idempotency.spec.ts`**

- Happy path: `POST /transactions` with key succeeds, transaction created
- Duplicate: second `POST /transactions` with same key and body returns cached response, only one `Transaction` row exists in the database
- Payload mismatch: second request with same key but different body returns `409`
- Concurrent requests: two simultaneous `POST /transactions` with same key — only one creates a `Transaction` row

### Concurrency test

Use a barrier/latch to send two identical requests simultaneously and assert that only one `Transaction` row is created and the Stellar payment is submitted once.

### Failure and retry test

- First request fails (validation error): record is `FAILED`, retry with same key re-executes
- First request fails (Stellar error): record is `FAILED`, retry with same key re-executes

### Expiration test

- Record older than 24 hours is cleaned up by scheduled job
- Stale `PROCESSING` record (older than timeout) is reset to `FAILED`

---

## Implementation Roadmap

### Phase 1: Prisma model

Create the `IdempotencyRecord` model in `prisma/schema.prisma` and generate a migration.

Files to modify:
- `prisma/schema.prisma`

### Phase 2: Repository

Create `src/modules/idempotency/idempotency.repository.ts` with methods:
- `reserve(key, fingerprint, organizationId)` — atomic INSERT, throws on conflict
- `findByKey(key)` — read existing record
- `complete(key, status, responseBody, transactionId?)` — update to COMPLETED
- `fail(key, responseBody?)` — update to FAILED
- `cleanup()` — delete expired records

### Phase 3: Custom decorator

Create `src/common/decorators/idempotent.decorator.ts`.

### Phase 4: Interceptor

Create `src/common/interceptors/idempotency.interceptor.ts`.

### Phase 5: Wire up

- Register interceptor in `src/app.module.ts` (before other interceptors)
- Apply `@Idempotent()` decorator to the five state-mutating endpoints

### Phase 6: Cleanup job

Create a scheduled task (using `@nestjs/schedule`) to delete expired `IdempotencyRecord` rows.

### Phase 7: Tests

Add unit and integration tests as described in the Testing Strategy section.

### Phase 8: API documentation

Update `API_DOCUMENTATION.md` to document the `Idempotency-Key` header behavior.

---

## Open Design Decisions

The following decisions should be resolved by the maintainer before implementation:

1. **Mandatory vs optional key**: Should `POST /transactions` reject requests without `Idempotency-Key`, or is it opt-in? (This document recommends opt-in.)

2. **Concurrent duplicate response**: Should a second request arriving while the first is `PROCESSING` return `409 Conflict` or `202 Accepted`? (This document recommends `409`.)

3. **FAILED retry behavior**: Should a `FAILED` record allow re-execution with the same key, or should it be treated as terminal? (This document recommends retryable.)

4. **Response body storage**: Should the full response body be cached, or just the transaction ID? Full body enables exact replay but stores more data. (This document recommends full body.)

5. **Key length minimum**: What is the minimum acceptable key length? (This document recommends 16 characters.)

6. **Retention period**: How long should idempotency records be retained? (This document recommends 24 hours.)
