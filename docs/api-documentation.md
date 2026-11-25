# API Documentation (OpenAPI / Swagger)

The OpenAPI document is generated from the controllers and their DTOs. It is
served by the Swagger UI at `/docs` in every environment except production, and
it is validated in CI.

```bash
npm run docs:check   # generates the document and asserts that it is complete
```

The check builds the real `AppModule` (Prisma mocked, no database, Redis or
network needed), applies the global prefix with the same exclusions as `main.ts`
(`src/common/constants/global-prefix.ts`), generates the document with the same
configuration `main.ts` serves (`buildSwaggerConfig()` in
`src/common/openapi/swagger-config.ts`) and compares it with the routes the
application registers. Those routes come from Nest's router metadata
(`DiscoveryService`, `MetadataScanner` and Nest's own `RoutePathFactory`), not
from Swagger or a hand-written list, so a new controller is covered as soon as it
is registered, and a route hidden with `@ApiExcludeEndpoint()` or
`@ApiExcludeController()` is still counted. Nest's `:param` placeholders become
OpenAPI `{param}` and trailing slashes are dropped before matching.

Every registered route that is not on the internal-route allowlist is checked on
its own, and each kind of gap is a separate test:

| Check | Fails when |
|---|---|
| `path` | the route's path is missing from the document |
| `method` | the path is documented but not for the route's HTTP method |
| `summary` | the operation has no non-empty `@ApiOperation({ summary })` |
| `tags` | the operation has no tag (`@ApiTags`) |
| `requestBody` | the handler takes a `@Body()` but the operation documents no request body schema (any method; routes without `@Body()`, such as `POST /agents/{id}/pause`, need no body) |
| `clientError` | no `4xx` response is documented (a `5xx` alone does not count) |
| `security` | a guarded route (not `@Public()`) declares no security requirement, operation-level or inherited, or names a scheme the document does not define (`access-token`, `api-key`) |
| `publicSecurity` | a `@Public()` route declares a security requirement |

It also asserts that:

- every `@Controller()` class under `src/modules` is registered in a module, so
  none of its routes escape the checks,
- every documented operation is served by a route, so a wrong prefix or a stale
  path cannot hide,
- no method and path is registered by two handlers (Express serves the first,
  while the document may describe the other),
- every operation has a 2xx response with a **schema** in the standard envelope,
- every body-accepting route references a named request DTO schema,
- every operation of an authenticated (not `@Public()`) route declares a security
  scheme that the document defines (`access-token` or `api-key`),
- every operation of an authenticated route offers **both** credentials as
  alternatives, because `JwtAuthGuard` accepts a bearer JWT or an API key,
- every error response documents a body, and that body is a `$ref` to a shared
  component schema rather than an inline copy,
- every operation documents the standard errors it can really answer with: 429
  and 500 everywhere, 401 and 403 on authenticated routes, 400 when it accepts a
  request body, and 404 when its path ends in a parameter addressing one
  resource,
- exactly one component schema (`ApiEnvelopeDto`) declares the success envelope,
- every `$ref` of the document resolves — there are no missing type definitions,
- every property of every schema is documented (directly or through the schema
  it references).

A per-route failure names the controller, the handler, the method and the path,
then what is missing, for example:

```
AssertionError: 1 route(s) fail the 'clientError' check: expected [ Array(1) ] to deeply equal []
+   "AuditController.findOne (GET /api/v1/audit/{id}): missing 4xx error response",
```

The helpers live in `src/common/openapi/openapi-coverage.ts`; their own tests
(`openapi-coverage.spec.ts`) run them against deliberately broken documents and a
small application with an undocumented route.

### Internal routes

A route that must stay out of the published document goes on the
`INTERNAL_ROUTES` allowlist in `src/openapi.spec.ts`, with a comment and a
`reason`. Today that is `GET /metrics` (the Prometheus scrape endpoint),
`POST /api/v1/webhooks/receive` (partner webhook ingress authenticated by HMAC
signature) and the internal diagnostic health routes under `/api/v1/health`. The
check fails when an entry has no reason, no longer matches a route, or matches a
route that is now documented, so the list cannot go stale. Everything else is
documented; do not add an entry to make the check pass.

### Routes without a client error

A documented route that cannot answer with any `4xx` goes on
`NO_CLIENT_ERROR_ROUTES` in `src/openapi.spec.ts`, with a comment and a
`reason`; it skips only the `clientError` check. Today that is the orchestrator
probes `GET /health/live` and `GET /health/ready`, which are public, take no
input and skip every rate limiter. An entry fails the check when it has no
reason, no route, no documented operation, or when the route now documents a
`4xx`.

## Conventions

### Success responses

Every endpoint answers with the success envelope
`{ success, data, meta, requestId }`. The `@ApiEnvelope` decorator documents
it and must be the **only** decorator that describes the success response:

```ts
@Get(':id')
@ApiEnvelope(TransactionResponseDto, { description: 'Transaction details' })
findOne(...) {}
```

Options:

| Option | Meaning |
| --- | --- |
| `isArray` | The payload is an array of the model. |
| `status` | The HTTP status of the success response (default `200`, `201` for creations). |
| `description` | The description of the response. |
| `headers` | Response headers to document. |

`@ApiPaginatedEnvelope(model)` is the shorthand for a list endpoint: it
documents the array payload and the `X-Total-Count` header.

Because the last decorator applied to a status wins, a plain
`@ApiResponse({ status: 200 })` next to an `@ApiEnvelope` would drop the
envelope schema. Use the envelope decorator alone.

### Error responses

Every error answers with an RFC 9457 problem details document
(`application/problem+json`). `GlobalExceptionFilter` (registered globally in `AppModule`)
intercepts all domain exceptions, validation failures, database errors, and unexpected
faults, mapping them to this uniform envelope. The `@ApiErrorResponses` decorator
documents the status codes an endpoint can actually return and references the shared
`ApiErrorEnvelopeDto` schema:

```ts
@ApiErrorResponses({
  validation: 'Validation error (invalid wallet UUID)',
  unauthorized: true,
  forbidden: 'Insufficient permissions (requires OWNER or ADMIN)',
  notFound: true,
  conflict: 'Wallet is already frozen',
  serverError: true,
})
```

`true` uses the default description of the status code, a string overrides it.
The supported statuses are `validation` (400), `unauthorized` (401),
`forbidden` (403), `notFound` (404), `conflict` (409), `unprocessable` (422),
`tooManyRequests` (429), `serverError` (500) and `serviceUnavailable` (503).

The errors every handler of a controller shares are declared once at class
level; a handler-level declaration overrides the same status:

```ts
@ApiAuthenticated()
@Controller('agents')
@ApiErrorResponses({ unauthorized: true, forbidden: true, tooManyRequests: true, serverError: true })
export class AgentController {}
```

A path parameter does not always address a stored resource: a literal sub-path
under a parameter (`/audit/resources/{resourceId}/timeline`,
`/admin/dlq/{queue}/purge`) is a scoped collection or action that answers an
empty result rather than 404, so the 404 requirement applies only to paths ending
in the parameter. The infrastructure probes (`/health/live`, `/health/ready`) are
exempt from the standard-error and problem-details checks: they answer the
success envelope with `success: false` and are not rate limited.

### Authentication

Protected controllers and handlers use `@ApiAuthenticated()`, which documents
both credentials the guard accepts:

```ts
@ApiAuthenticated()   // ApiBearerAuth('access-token') + ApiSecurity('api-key')
@Controller('wallets')
export class WalletController {}
```

The two schemes are alternatives (`security: [{ 'access-token': [] }, { 'api-key': [] }]`),
not a combined requirement. A controller mixing public and authenticated routes
(`AuthController`) applies the decorator per handler instead.

### Request bodies

Request bodies are documented with `@ApiBody({ type: XDto })`. The DTO classes
exist for documentation only — the validation is done by the Zod pipes.

### DTOs

Every property of a DTO carries a description and, where it helps, an example:

```ts
@ApiProperty({ example: '125.5000000', description: 'Amount to transfer, with up to 7 decimals' })
amount!: string;
```

Properties whose type is an enum are rendered as a reference to the shared
enum schema; the description is hoisted onto that schema by the Swagger
generator, so it stays visible in the UI.

### Pagination

List endpoints use `@ApiPaginationQuery()` for the query parameters and
`@ApiPaginatedEnvelope(model)` for the response, which documents the
`X-Total-Count` header.
