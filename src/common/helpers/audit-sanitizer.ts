/**
 * Sensitive field keys that must never appear in audit-logged payloads.
 * Scrubbed recursively from any object or nested structure.
 */
const SENSITIVE_FIELDS = [
  'password',
  'passphrase',
  'passkey',
  'challenge',
  'secret',
  'privatekey',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'credentials',
  'signature',
  'mnemonic',
  'seedphrase',
  'hashedkey',
];

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;
const MAX_COLLECTION_SIZE = 500;
const MAX_STRING_LENGTH = 2_048;
const CIRCULAR = '[Circular]';
const MAX_DEPTH_MARKER = '[MaxDepth]';
const TRUNCATED = '[Truncated]';

const SENSITIVE_TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`],
  [
    /\b(password|passphrase|token|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|webhook[_ -]?secret|secret[_ -]?key|signature|authorization|cookie|private[_ -]?key|mnemonic|seedphrase|passkey|challenge)\s*([:=])\s*(?!(?:Bearer|Basic)\b)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    `$1$2 ${REDACTED}`,
  ],
  [/\bS[A-Z2-7]{55}\b/g, REDACTED],
  [/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9_-]+/gi, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/gi, REDACTED],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
];

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of SENSITIVE_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : redacted;
}

export function isSensitiveField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_\s-]/g, '');
  return SENSITIVE_FIELDS.some((fragment) => normalized.includes(fragment));
}

export function sanitizeAuditPayload<T>(data: T): T {
  return redactValue(data, 0, new WeakSet<object>()) as T;
}

export function sanitizeLogArguments(args: readonly unknown[]): unknown[] {
  return args.map((argument) => sanitizeAuditPayload(argument));
}

function redactValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return MAX_DEPTH_MARKER;

  const object = value as object;
  if (ancestors.has(object)) return CIRCULAR;
  if (object instanceof Date) return object.toISOString();

  ancestors.add(object);
  try {
    if (object instanceof Error) {
      const errorRecord: Record<string, unknown> = {
        name: redactSensitiveText(object.name),
        message: redactSensitiveText(object.message),
      };
      if (object.stack) errorRecord.stack = redactSensitiveText(object.stack);
      for (const key of Object.keys(object).slice(0, MAX_COLLECTION_SIZE)) {
        if (key === 'name' || key === 'message' || key === 'stack') continue;
        errorRecord[key] = isSensitiveField(key)
          ? REDACTED
          : redactValue((object as unknown as Record<string, unknown>)[key], depth + 1, ancestors);
      }
      if ('cause' in object && !Object.prototype.hasOwnProperty.call(errorRecord, 'cause')) {
        errorRecord.cause = redactValue((object as Error & { cause?: unknown }).cause, depth + 1, ancestors);
      }
      return errorRecord;
    }

    if (Array.isArray(object)) {
      const items = object.slice(0, MAX_COLLECTION_SIZE).map((item) => redactValue(item, depth + 1, ancestors));
      if (object.length > MAX_COLLECTION_SIZE) items.push(TRUNCATED);
      return items;
    }

    const result: Record<string, unknown> = {};
    const keys = Object.keys(object).slice(0, MAX_COLLECTION_SIZE);
    for (const key of keys) {
      result[key] = isSensitiveField(key)
        ? REDACTED
        : redactValue((object as Record<string, unknown>)[key], depth + 1, ancestors);
    }
    if (Object.keys(object).length > MAX_COLLECTION_SIZE) result[TRUNCATED] = TRUNCATED;
    return result;
  } catch {
    return '[Unserializable]';
  } finally {
    ancestors.delete(object);
  }
}
