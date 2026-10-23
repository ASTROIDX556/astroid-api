# Structured audit logging

Sensitive operations (key rotation, budget adjustments, policy updates, transfers, …) must leave an immutable, structured trail. Astroid records them with the `StructuredAuditInterceptor`, which publishes an `audit.recorded` event on the internal event bus.

## Marking a route

`@AuditAction()` marks a controller method (or a whole controller) as requiring an audit trail:

```ts
@Post(':id/rotate')
@AuditAction('AGENT_KEY_ROTATED')
@AuditAction({ action: 'AGENT_KEY_ROTATED', entity: 'ApiKey' })
rotate(@Param('id') id: string) { /* … */ }
```

The object form additionally records the domain entity and a human-readable description. The decorator only stores metadata — `normalizeAuditAction()` resolves it for the interceptors.

`@SkipAudit()` always wins over `@AuditAction()`.

## What is captured

| Field | Source |
| --- | --- |
| `action`, `entity`, `description` | `@AuditAction()` metadata |
| `method`, `url` | The request |
| `body`, `params`, `query` | The request, passed through `sanitizeAuditPayload()` |
| `userId` | The authenticated principal |
| `agentId` | The acting agent, from the ambient `TraceContext` |
| `ipAddress`, `userAgent` | The request (`x-forwarded-for` is honoured) |
| `requestId`, `traceId` | The ambient `TraceContext` |
| `statusCode`, `success` | The response |
| `durationMs`, `occurredAt` | The handler run |

Private keys, secrets, API keys, bearer tokens and JWTs are redacted by the shared audit sanitizer **before** the event is built, so they never reach the event bus, the domain-event ledger or the audit log.

## The pipeline

```
StructuredAuditInterceptor
  └─ EventBusService.emit('audit.recorded', payload, …)   ← not awaited
       ├─ domain_events ledger (immutable)
       └─ @nestjs/event-emitter
            └─ AuditRecordedListener → AuditService.record() → audit_logs
```

The interceptor never awaits the publication: the response cycle is not delayed by the audit write. `AuditRecordedListener` turns the event into the hash-chained audit-log row, and swallows (but logs) any persistence failure so an audit outage never breaks the audited operation.

## One row per operation

Three interceptors can observe a request, so the ownership is explicit:

| Interceptor | Scope |
| --- | --- |
| `AuditInterceptor` | Every request without a semantic action — the broad safety net |
| `AuditLogInterceptor` | Routes decorated with `@AuditLog()` that do **not** declare `@AuditAction()` |
| `StructuredAuditInterceptor` | Routes decorated with `@AuditAction()` — the semantic, event-bus backed trail |

A route that declares `@AuditAction()` is therefore audited exactly once, by the structured path.

## Tests

- `src/common/interceptors/structured-audit.interceptor.spec.ts` — the interceptor: metadata capture, redaction, error status codes, and that the response is not blocked.
- `src/common/interceptors/structured-audit.integration.spec.ts` — the full pipeline, from the interceptor through the real `@nestjs/event-emitter` to the audit row.
- `src/modules/audit/audit-recorded.listener.spec.ts` — the listener: row shape, missing context, and failure isolation.
