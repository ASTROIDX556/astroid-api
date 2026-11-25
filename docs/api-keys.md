# API Key Scopes & Authentication

Programmatic API keys allow service-to-service communication with granular, least-privilege permission scoping.

## Scope Vocabulary

Astroid API supports four standard scopes for API keys:

| Scope | Description | Allowed Operations |
|---|---|---|
| `read` | Read-only access to resources | `GET /developer/api-keys`, `GET /webhooks`, `GET /webhooks/deliveries`, `GET /webhooks/:id` |
| `write` | Developer surface configuration mutations | `POST /developer/api-keys`, `POST /developer/api-keys/:id/rotate`, `DELETE /developer/api-keys/:id` |
| `transactions:execute` | Submit on-chain transactions | `POST /transactions` |
| `webhooks:manage` | Manage organization webhooks | `POST /webhooks`, `PATCH /webhooks/:id`, `POST /webhooks/:id/rotate-secret`, `DELETE /webhooks/:id` |

## Key Creation & Defaults

When creating an API key (`POST /developer/api-keys`), client applications can explicitly declare the required scopes:

```json
{
  "name": "Payment Worker Key",
  "scopes": ["read", "transactions:execute"]
}
```

- **Default Scope**: If `scopes` is omitted during key creation, it defaults to `["read"]`.
- **Validation**: Scopes must contain between 1 and 4 valid scope strings matching the defined vocabulary. Unknown scopes are rejected with `400 Bad Request`.
- **Migration & Backwards Compatibility**: Existing API keys receive the `["read"]` safe default. Valid legacy `permissions` values are copied into `scopes` by migration to preserve their previously granted operations. Arbitrary legacy values are discarded; integrations that need a protected write operation must use a supported scope.

## Enforcement

Routes requiring authorization are decorated with `@RequiredScopes(...)`. When an API key authenticates:
1. `ScopesGuard` evaluates the scopes granted to the API key.
2. Scope values match exactly; wildcards and arbitrary strings are not accepted as grants. If any required scope is missing, the request is denied with `403 Forbidden` and machine-readable `ErrorCode.FORBIDDEN`:
   ```json
   {
     "type": "urn:astroid:problem:forbidden",
     "title": "Forbidden",
     "status": 403,
     "detail": "Insufficient API key permissions. Missing required scope(s): transactions:execute",
     "code": "FORBIDDEN",
     "instance": "/transactions",
     "requestId": "req_018f0a1b-..."
   }
   ```
3. The global guard order is authentication, role authorization, then scope authorization. `OWNER` and `ADMIN` users authenticated with JWTs bypass scope checks; other JWT users and all API keys must hold every route-required scope. This exception is limited to routes explicitly decorated with `@RequireScopes(...)`.

## Protected route scope table

| Endpoint | Required scope |
|---|---|
| `GET /developer/api-keys` | `read` |
| `POST /developer/api-keys` | `write` |
| `DELETE /developer/api-keys/:id` | `write` |
| `POST /transactions` | `transactions:execute` |
| `GET /webhooks`, `GET /webhooks/deliveries`, `GET /webhooks/:id` | `read` |
| `POST /webhooks`, `PATCH /webhooks/:id`, `POST /webhooks/:id/rotate-secret`, `DELETE /webhooks/:id` | `webhooks:manage` |

## API Key Rotation & Grace Period

Integrators can rotate API keys without breaking live traffic via `POST /developer/api-keys/:id/rotate`.

- **Rotation Flow**:
  - Mints a replacement key with the same scopes, permissions, and IP restrictions as the original key.
  - The previous key remains a separate row with its hash and is marked `status: 'rotating'`; `previousKeyExpiresAt` limits its grace period without changing the key's original `expiresAt`.
  - The new key is returned in plaintext exactly once in the response. If no new expiry is requested, it inherits the original key's expiry.
  - The default grace period is 86,400 seconds (24 hours), configurable with `API_KEY_ROTATION_GRACE_PERIOD_SECONDS` or per request with `gracePeriodSeconds` (maximum 30 days).
- **Grace Period Authentication**:
  - Both the new key and the rotating key remain valid until the earlier of the previous key's original expiry and `previousKeyExpiresAt`.
  - Once that deadline passes, authentication with the rotating key fails with standard `401 Unauthorized`.
- **Conflict Prevention**:
  - Only the actor who created a key can rotate it. Attempting to rotate another actor's key returns `404 Not Found`.
  - Attempting to rotate a key that is already rotating, revoked, or expired immediately returns `409 Conflict`; concurrent rotations are serialized so only one replacement is created.
- **Immediate Revocation**:
  - Revoking a key (`DELETE /developer/api-keys/:id`) is immediate and rejects authentication immediately, regardless of any active grace period.
- **Audit Logging**:
  - Key rotations are recorded in the immutable audit log (`AGENT_KEY_ROTATED`), tracking the actor ID, organization ID, previous key ID, and prefix.
