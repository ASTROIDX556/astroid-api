# Sensitive-Data Redaction

`sanitizeAuditPayload` and `redactSensitiveText` in `src/common/helpers/audit-sanitizer.ts` are the shared policy for structured logging and audit metadata. The Pino logger formatter/hook, worker log scrubber, audit interceptor, and `AuditService.record` use this policy. Audit hashes are calculated from sanitized metadata; persisted domain records are unchanged.

The policy redacts authorization and cookie values, passwords, passphrases, access/refresh tokens, API keys (`apiKey`, `api_key`, `x-api-key`), private/secret keys, webhook signing secrets, signatures, passkey challenges, credentials, Stellar seeds, Idempotency-Key values, and common credential-shaped text. Header keys are matched case-insensitively after normalising `-`, `_` and spaces, so `Authorization`, `authorization` and `X-Api-Key` are all covered. Add future sensitive field names to `SENSITIVE_FIELDS` or add narrowly scoped free-text patterns to `SENSITIVE_TEXT_PATTERNS`; avoid domain-specific copies of the key list.

Redacted values use `[REDACTED]`. The sanitizer does not mutate input, detects cycles, retains useful error name/message/stack and attached context, and caps recursion depth (8), collection size, and string length. Correlation IDs, record IDs, status codes, and public Stellar addresses remain available.

### Configuring extra field names

The built-in list covers the platform's own credentials. A deployment can add
application-specific field names without a code change:

```
LOG_REDACT_FIELDS=accountNumber,payoutDetails
```

Each entry is matched like the defaults — case-insensitive, ignoring `_`, `-`
and spaces, as a substring of the key. The list is validated with the rest of
the environment at boot and applied before the logger is constructed, so it also
covers every log line written during startup. An empty value (the default) keeps
the built-in list only.

## Where redaction is applied

Redaction is configured once, at the logger, in `src/common/logging/pino-http.options.ts`, so every log statement inherits it and call sites never have to remember it:

| Layer             | What it does                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `redact`          | Removes the header paths `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-api-key"]`, `req.headers["idempotency-key"]` and `res.headers["set-cookie"]` from any logged request or response object. |
| `formatters.log`  | Masks sensitive **keys** in every structured object, at any depth.                                                       |
| `hooks.logMethod` | Applies the same policy to every argument, including the free-text message, so a token inside an error message is masked. |

## Rules

| Rule                                              | Matches                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Sensitive key names (case, `_`, `-` and spaces ignored) | any key containing `password`, `passphrase`, `passkey`, `challenge`, `secret`, `privatekey`, `token`, `apikey`, `authorization`, `cookie`, `credentials`, `signature`, `mnemonic`, `seedphrase`, `hashedkey` — so `refreshToken`, `signingSecret`, `x-api-key` and `webhookSecret` are covered |
| Bearer / Basic credentials in text                | `Bearer <token>`, `Basic <token>`                                                                                             |
| `name=value` / `name: value` pairs in text        | the same sensitive names, e.g. `token=abc`, `password: hunter2`                                                               |
| JWT-shaped strings                                | three base64url segments separated by dots, wherever they appear                                                              |
| Platform API keys                                 | `ak_<environment>_<secret>`; the 14-character display prefix (`ak_live_ab12cd`) stays readable                                |
| Webhook signing secrets, provider keys, seeds     | `whsec_…`, `sk-…`, Stellar secret seeds (`S…`, 56 characters)                                                                  |
| Credentials embedded in URLs                      | `scheme://user:password@host`                                                                                                 |

Fields such as `requestId`, `method`, `path`, `statusCode` and `durationMs` are not matched and stay readable.

## Request bodies are never logged


`autoLogging` is disabled and the request logging middleware
(`src/middleware/structured-request-logging.middleware.ts`) writes an explicit
**allow-list** of fields: `requestId`, `method`, `path`, `statusCode` and
`durationMs`. Nothing from the body, query string or headers can reach the log
through it, which includes the auth, API-key and webhook-secret endpoints. A test
pins the allow-list. If body logging is ever needed, add the route to an
allow-list; do not log bodies and try to mask them afterwards.

## Example

A request that carried `Authorization: Bearer <jwt>` and an API key:

```json
{"level":30,"requestId":"req-42","method":"POST","path":"/api/v1/transactions","statusCode":201,"durationMs":12.5,"msg":"HTTP request completed"}
```

The same policy applied to an error that quotes a credential:

```text
upstream rejected Authorization: [REDACTED]
```
