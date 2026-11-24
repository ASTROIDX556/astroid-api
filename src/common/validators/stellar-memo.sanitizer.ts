import { ValidationException } from '../exceptions/domain.exception';

/**
 * Memo types supported by the Stellar protocol.
 */
export type MemoType = 'text' | 'id' | 'hash' | 'return';

/**
 * Sanitized memo output with explicit type.
 */
export interface SanitizedMemo {
  type: MemoType;
  value: string;
}

/**
 * Maximum byte length for Stellar TEXT memos.
 */
const STELLAR_TEXT_MEMO_MAX_BYTES = 28;

/**
 * Required byte length for HASH/RETURN memos.
 */
const STELLAR_HASH_MEMO_BYTES = 32;

/**
 * Maximum value for Stellar ID memo (2^64 - 1).
 */
const STELLAR_ID_MEMO_MAX = BigInt('18446744073709551615');

/**
 * Sanitizes and normalizes a raw memo input for the Stellar TEXT type.
 *
 * - Trims leading/trailing whitespace.
 * - Rejects null bytes (\0).
 * - Rejects empty or whitespace-only values.
 * - Validates UTF-8 byte length <= 28.
 */
export function sanitizeTextMemo(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new ValidationException('Text memo cannot be empty or whitespace only');
  }

  if (trimmed.includes('\0')) {
    throw new ValidationException('Text memo contains null bytes which are not allowed');
  }

  const byteLength = new TextEncoder().encode(trimmed).byteLength;
  if (byteLength > STELLAR_TEXT_MEMO_MAX_BYTES) {
    throw new ValidationException(
      `Text memo exceeds maximum length of ${STELLAR_TEXT_MEMO_MAX_BYTES} bytes (got ${byteLength} bytes)`,
    );
  }

  return trimmed;
}

/**
 * Sanitizes and normalizes a raw memo input for the Stellar ID type.
 *
 * - Removes leading zeros (except "0" itself).
 * - Validates the value is a non-negative integer.
 * - Validates range: 0 to 2^64 - 1.
 */
export function sanitizeIdMemo(raw: string): string {
  const trimmed = raw.trim();

  if (!/^\d+$/.test(trimmed)) {
    throw new ValidationException('Memo ID must contain only digits');
  }

  // Remove leading zeros but preserve "0"
  const normalized = trimmed.replace(/^0+(?=\d)/, '');

  try {
    const big = BigInt(normalized);
    if (big < BigInt(0) || big > STELLAR_ID_MEMO_MAX) {
      throw new ValidationException(
        `Memo ID must be in range 0 to ${STELLAR_ID_MEMO_MAX}`,
      );
    }
  } catch (e) {
    if (e instanceof ValidationException) throw e;
    throw new ValidationException('Memo ID is not a valid unsigned 64-bit integer');
  }

  return normalized;
}

/**
 * Sanitizes and normalizes a raw memo input for the Stellar HASH type.
 *
 * - Converts to lowercase.
 * - Validates exactly 64 hex characters (32 bytes).
 */
export function sanitizeHashMemo(raw: string): string {
  const trimmed = raw.trim().toLowerCase();

  if (!/^[0-9a-f]+$/.test(trimmed)) {
    throw new ValidationException('Hash memo must contain only hexadecimal characters');
  }

  if (trimmed.length !== STELLAR_HASH_MEMO_BYTES * 2) {
    throw new ValidationException(
      `Hash memo must be exactly ${STELLAR_HASH_MEMO_BYTES * 2} hex characters (${STELLAR_HASH_MEMO_BYTES} bytes), got ${trimmed.length} characters`,
    );
  }

  return trimmed;
}

/**
 * Sanitizes and normalizes a raw memo input for the Stellar RETURN type.
 *
 * - Converts to lowercase.
 * - Validates exactly 64 hex characters (32 bytes).
 */
export function sanitizeReturnMemo(raw: string): string {
  return sanitizeHashMemo(raw);
}

/**
 * Determines the memo type and sanitizes the value accordingly.
 *
 * Accepts a raw memo object with `type` and `value` fields, or a plain string
 * (treated as TEXT type).
 *
 * Returns a normalized `SanitizedMemo` with explicit type and sanitized value.
 */
export function sanitizeMemo(input: { type: MemoType; value: string } | string): SanitizedMemo {
  if (typeof input === 'string') {
    return { type: 'text', value: sanitizeTextMemo(input) };
  }

  switch (input.type) {
    case 'text':
      return { type: 'text', value: sanitizeTextMemo(input.value) };
    case 'id':
      return { type: 'id', value: sanitizeIdMemo(input.value) };
    case 'hash':
      return { type: 'hash', value: sanitizeHashMemo(input.value) };
    case 'return':
      return { type: 'return', value: sanitizeReturnMemo(input.value) };
    default:
      throw new ValidationException(`Unknown memo type: '${(input as { type: string }).type}'`);
  }
}
