import { createHash } from 'node:crypto';

/**
 * Serialises a value with object keys sorted at every depth, so two requests
 * that differ only in key order (or in how a JSON encoder ordered them) produce
 * the same fingerprint.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Raw idempotency keys are never persisted; only their digest is. */
export function hashIdempotencyKey(key: string): string {
  return sha256(key);
}

export interface RequestFingerprintInput {
  /** Normalized request body. */
  body: unknown;
  /** Relevant route parameters (path params that scope the request). */
  params?: Record<string, unknown>;
}

/**
 * Deterministic digest of a request. `params` is omitted when empty so a route
 * without path parameters keeps the same fingerprint as before it had any.
 */
export function computeRequestFingerprint(input: RequestFingerprintInput): string {
  const params = input.params
    ? Object.fromEntries(
        Object.entries(input.params).filter(([, value]) => value !== undefined),
      )
    : undefined;
  const payload = params && Object.keys(params).length > 0
    ? { body: input.body, params }
    : { body: input.body };
  return sha256(canonicalJson(payload));
}
