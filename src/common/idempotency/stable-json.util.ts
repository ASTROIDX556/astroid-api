/**
 * Deterministic JSON serialization used for Idempotency-Key request hashing.
 *
 * Object keys are sorted recursively so two semantically identical bodies hash
 * identically regardless of key order in the JSON document. Array order is
 * preserved (it is part of the request's meaning). Dates become ISO strings and
 * `undefined`/functions are omitted, matching what JSON would transmit.
 */
export function stableStringify(value: unknown): string {
  return serialize(value, new WeakSet<object>());
}

function serialize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    default:
      break;
  }

  const object = value as object;
  if (object instanceof Date) return JSON.stringify(object.toISOString());
  if (ancestors.has(object)) return '"[Circular]"';

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => serialize(item, ancestors)).join(',')}]`;
    }
    const entries = Object.keys(object as Record<string, unknown>)
      .filter((key) => {
        const item = (object as Record<string, unknown>)[key];
        return typeof item !== 'undefined' && typeof item !== 'function' && typeof item !== 'symbol';
      })
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serialize((object as Record<string, unknown>)[key], ancestors)}`,
      );
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}
