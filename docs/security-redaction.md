# Sensitive-Data Redaction

`sanitizeAuditPayload` and `redactSensitiveText` in `src/common/helpers/audit-sanitizer.ts` are the shared policy for structured logging and audit metadata. The Pino logger formatter/hook, worker log scrubber, audit interceptor, and `AuditService.record` use this policy. Audit hashes are calculated from sanitized metadata; persisted domain records are unchanged.

The policy redacts authorization and cookie values, passwords, passphrases, access/refresh tokens, API keys, private/secret keys, webhook signing secrets, signatures, passkey challenges, credentials, Stellar seeds, and common credential-shaped text. Add future sensitive field names to `SENSITIVE_FIELDS` or add narrowly scoped free-text patterns to `SENSITIVE_TEXT_PATTERNS`; avoid domain-specific copies of the key list.

Redacted values use `[REDACTED]`. The sanitizer does not mutate input, detects cycles, retains useful error name/message/stack and attached context, and caps recursion depth, collection size, and string length. Correlation IDs, record IDs, status codes, and public Stellar addresses remain available.