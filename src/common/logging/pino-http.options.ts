import type { Options } from 'pino-http';
import { REQUEST_ID_HEADER } from '../constants/headers';
import { sanitizeAuditPayload, sanitizeLogArguments } from '../helpers/audit-sanitizer';

/**
 * Header paths removed from any logged request or response object. This is a
 * backstop for code that logs a whole `req`/`res`: the structured logger below
 * masks by key and by value as well, but a header that never reaches the sink is
 * the safest outcome.
 *
 * `idempotency-key` is included because replaying a key returns the cached
 * response of the original request, so it is treated like a credential.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
];

/**
 * Logger options for `nestjs-pino`. Redaction is applied here, at the source,
 * so every log statement in the application inherits it:
 *
 * - `redact` removes the credential-bearing header paths above;
 * - `formatters.log` masks sensitive keys (password, token, secret, apiKey,
 *   authorization, ...) and secret-shaped values in every structured object;
 * - `hooks.logMethod` runs the same policy over every argument, including the
 *   free-text message, so a bearer token inside an error message is masked too.
 *
 * Request bodies are never logged: `autoLogging` is off and the request logging
 * middleware writes an explicit allow-list of fields (request id, method, path,
 * status, duration).
 */
export function createPinoHttpOptions(): Options {
  return {
    // Reuse the request id set by RequestIdMiddleware for correlated logs.
    genReqId: (req) => (req.headers[REQUEST_ID_HEADER] as string) ?? undefined,
    redact: {
      paths: [...LOG_REDACT_PATHS],
      remove: true,
    },
    formatters: {
      log: (object: Record<string, unknown>) =>
        sanitizeAuditPayload(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        return method.apply(this, sanitizeLogArguments(args) as typeof args);
      },
    },
    autoLogging: false,
  };
}
