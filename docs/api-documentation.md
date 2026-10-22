# API Documentation (OpenAPI / Swagger)

The OpenAPI document is generated from the controllers and their DTOs. It is
served by the Swagger UI at `/docs` in every environment except production, and
it is validated in CI.

```bash
npm run docs:check   # generates the document and asserts that it is complete
```

The check builds the real `AppModule`, generates the document and asserts that:

- every operation has a tag, a summary and at least one documented response,
- every success response documents a response **schema**,
- every error response documents a body,
- every `$ref` of the document resolves to a schema that exists — there are no
  missing type definitions,
- every property of every schema is documented (directly or through the schema
  it references).

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
(`application/problem+json`). The `@ApiErrorResponses` decorator documents the
status codes an endpoint can actually return and references the shared
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
`tooManyRequests` (429) and `serverError` (500).

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
