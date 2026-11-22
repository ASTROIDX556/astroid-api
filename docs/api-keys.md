# API Key Scopes & Authentication

Programmatic API keys allow service-to-service communication with granular, least-privilege permission scoping.

## Scope Vocabulary

Astroid API supports four standard scopes for API keys:

| Scope | Description | Allowed Operations |
|---|---|---|
| `read` | Read-only access to resources | `GET /developer/api-keys`, `GET /webhooks`, `GET /webhooks/deliveries`, `GET /webhooks/:id` |
| `write` | Developer surface configuration mutations | `POST /developer/api-keys`, `DELETE /developer/api-keys/:id` |
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
- **Migration & Backwards Compatibility**: Existing API keys without explicit scopes are migrated to `["read"]` to ensure safe, read-only defaults.

## Enforcement

Routes requiring authorization are decorated with `@RequiredScopes(...)`. When an API key authenticates:
1. `ScopesGuard` evaluates the scopes granted to the API key.
2. If any required scope is missing, the request is denied with `403 Forbidden` and machine-readable `ErrorCode.FORBIDDEN`:
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
3. Full system administrators (users with `OWNER` or `ADMIN` roles authenticated via user JWT) bypass scope restrictions.
