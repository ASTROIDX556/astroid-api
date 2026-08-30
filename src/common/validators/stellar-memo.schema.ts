import { z } from 'zod';

/**
 * Stellar memo type enum.
 * Matches the four Stellar protocol memo types.
 */
export const stellarMemoTypeSchema = z.enum(['text', 'id', 'hash', 'return']);
export type StellarMemoType = z.infer<typeof stellarMemoTypeSchema>;

/**
 * Maximum byte length for a Stellar TEXT memo (per Stellar specification).
 */
const STELLAR_TEXT_MEMO_MAX_BYTES = 28;

/**
 * Maximum value for a Stellar ID memo (2^64 - 1).
 */
const STELLAR_ID_MEMO_MAX = BigInt('18446744073709551615'); // 2^64 - 1

/**
 * Encodes a string to UTF-8 bytes and returns the byte length.
 * This is different from string.length for multibyte characters.
 */
function utf8ByteLength(str: string): number {
  return new TextEncoder().encode(str).byteLength;
}

/**
 * Zod schema for a Stellar TEXT memo.
 * - Must be a non-empty string.
 * - Maximum 28 bytes when UTF-8 encoded (not 28 characters).
 * - Any valid UTF-8 content is accepted (no ASCII-only restriction per Stellar spec).
 */
export const textMemoValueSchema = z
  .string()
  .min(1, 'Text memo cannot be empty')
  .refine(
    (val) => utf8ByteLength(val) <= STELLAR_TEXT_MEMO_MAX_BYTES,
    `Text memo exceeds maximum length of ${STELLAR_TEXT_MEMO_MAX_BYTES} bytes`,
  );

/**
 * Zod schema for a Stellar ID memo.
 * - Must be a string representation of a non-negative integer.
 * - Valid range: 0 to 2^64 - 1 (18446744073709551615).
 * - Uses BigInt for exact 64-bit unsigned integer validation.
 */
export const idMemoValueSchema = z
  .string()
  .refine(
    (val) => /^\d+$/.test(val),
    'Memo ID must be a non-negative integer string',
  )
  .refine(
    (val) => {
      try {
        const big = BigInt(val);
        return big >= BigInt(0) && big <= STELLAR_ID_MEMO_MAX;
      } catch {
        return false;
      }
    },
    `Memo ID must be in range 0 to ${STELLAR_ID_MEMO_MAX}`,
  );

/**
 * Zod schema for a Stellar HASH memo.
 * - Must be a hex-encoded string of exactly 64 characters (32 bytes).
 * - Accepts both uppercase and lowercase hex (sanitizer normalizes to lowercase).
 */
export const hashMemoValueSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'Hash memo must be exactly 64 hex characters (32 bytes)');

/**
 * Zod schema for a Stellar RETURN memo.
 * - Must be a hex-encoded string of exactly 64 characters (32 bytes).
 * - Accepts both uppercase and lowercase hex (sanitizer normalizes to lowercase).
 */
export const returnMemoValueSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'Return memo must be exactly 64 hex characters (32 bytes)');

/**
 * Discriminated union of memo value schemas keyed by memoType.
 */
export const typedMemoSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: textMemoValueSchema }),
  z.object({ type: z.literal('id'), value: idMemoValueSchema }),
  z.object({ type: z.literal('hash'), value: hashMemoValueSchema }),
  z.object({ type: z.literal('return'), value: returnMemoValueSchema }),
]);
export type TypedMemo = z.infer<typeof typedMemoSchema>;

/**
 * Legacy memo format: a plain string (implicitly TEXT type).
 * Validated against the same TEXT constraints (non-empty, max 28 bytes UTF-8).
 */
export const legacyMemoSchema = z
  .string()
  .min(1, 'Memo cannot be empty')
  .refine(
    (val) => utf8ByteLength(val) <= STELLAR_TEXT_MEMO_MAX_BYTES,
    `Memo exceeds maximum length of ${STELLAR_TEXT_MEMO_MAX_BYTES} bytes`,
  );

/**
 * Combined memo schema that accepts either:
 * - A legacy plain string (treated as TEXT memo), or
 * - A typed object with `type` and `value` fields.
 *
 * When a plain string is provided, it is transformed into `{ type: 'text', value: string }`
 * for consistent downstream handling.
 */
export const stellarMemoSchema = z
  .union([typedMemoSchema, legacyMemoSchema])
  .transform((val) => {
    if (typeof val === 'string') {
      return { type: 'text' as const, value: val };
    }
    return val;
  });

export type StellarMemo = z.infer<typeof stellarMemoSchema>;
