# Sensitive-Data Redaction

`sanitizeAuditPayload` and `redactSensitiveText` in `src/common/helpers/audit-sanitizer.ts` are the shared policy for structured logging and audit metadata. The Pino logger formatter/hook, worker log scrubber, audit interceptor, and `AuditService.record` use this policy. Audit hashes are calculated from sanitized metadata; persisted domain records are unchanged.

The policy redacts authorization and cookie values, passwords, passphrases, access/refresh tokens, API keys (`apiKey`, `api_key`, `x-api-key`), private/secret keys, webhook signing secrets, signatures, passkey challenges, credentials, Stellar seeds, Idempotency-Key values, and common credential-shaped text. Header keys are matched case-insensitively after normalising `-`, `_` and spaces, so `Authorization`, `authorization` and `X-Api-Key` are all covered. Add future sensitive field names to `SENSITIVE_FIELDS` or add narrowly scoped free-text patterns to `SENSITIVE_TEXT_PATTERNS`; avoid domain-specific copies of the key list.

Redacted values use `[REDACTED]`. The sanitizer does not mutate input, detects cycles, retains useful error name/message/stack and attached context, and caps recursion depth, collection size, and string length. Correlation IDs, request IDs, actor IDs, module names, log levels, record IDs, status codes, and public Stellar addresses remain available.

## Size limits

A single log string is capped at `MAX_LOG_STRING_LENGTH` (2,048 characters). Values longer than that are truncated with an explicit marker:

- ordinary payloads keep the first 2,048 characters followed by `...[truncated]`;
- base64 blobs, data URIs and signed XDR envelopes keep a 256-character prefix followed by `...[truncated binary, <n> chars]`;
- `Buffer`/typed-array values are replaced with `[Binary <n> bytes]` without expanding their contents.

The same `sanitizeAuditPayload`/`redactSensitiveText` functions back both HTTP logging (`LoggerModule` formatter and hook in `src/app.module.ts`) and worker logging (`scrubForLog`/`scrubString` in `src/utils/log-scrubber.util.ts`), so an HTTP request and a background worker redact identically.