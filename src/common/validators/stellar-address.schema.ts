import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

/**
 * Reusable Zod validators for Stellar strkeys.
 *
 * Standardizes address validation at the API boundary so malformed requests are
 * rejected before they reach business logic or transaction queues. Unlike the
 * ad-hoc string checks used previously, these validate the full base32 encoding
 * AND the Stellar CRC16-XModem checksum via the SDK's `StrKey`, so an address
 * with a corrupted checksum (but otherwise valid characters/length) is caught.
 *
 * Char-set note: Stellar uses base32 (RFC 4648 without padding) — uppercase
 * `A–Z` plus digits `2–7`. Digits `0`/`1`, lowercase, and characters like `I`/`O`
 * are rejected.
 */

/** Uppercase base32 alphabet used by Stellar strkeys (A–Z, digits 2–7). */
const STELLAR_STRKEY_CHARSET = /^[A-Z2-7]+$/;

/**
 * Standard byte-payload → strkey lengths:
 *  - Ed25519 public key:  1 version + 32 bytes  + 2 checksum = 56 chars
 *  - Contract id:         1 version + 32 bytes  + 2 checksum = 56 chars
 *  - Multiplexed (M...):  1 version + 32 + 8 id + 2 checksum = 69 chars
 */
export const STELLAR_PUBLIC_KEY_LENGTH = 56;
export const STELLAR_CONTRACT_ID_LENGTH = 56;
export const STELLAR_MED25519_PUBLIC_KEY_LENGTH = 69;

interface StrKeySchemaParams {
  prefix: 'G' | 'C' | 'M';
  label: string;
  length: number;
  check: (value: string) => boolean;
}

/**
 * Builds a strict Stellar strkey schema for a single prefix. Checks run in
 * order so each failure gets the most specific, helpful message possible:
 * missing input → wrong prefix → wrong length → invalid characters → bad checksum.
 */
function buildStrKeySchema(params: StrKeySchemaParams): z.ZodType<string> {
  return z
    .string({ invalid_type_error: `Stellar address must be a string` })
    .min(1, `Stellar ${params.label} is required`)
    .refine(
      (value) => value.startsWith(params.prefix),
      (value) => ({
        message: `Invalid Stellar ${params.label}: must start with '${params.prefix}', got '${value.charAt(0)}…'`,
      }),
    )
    .refine(
      (value) => value.length === params.length,
      (value) => ({
        message: `Invalid Stellar ${params.label}: expected exactly ${params.length} characters, got ${value.length}`,
      }),
    )
    .refine(
      (value) => STELLAR_STRKEY_CHARSET.test(value),
      `Invalid Stellar ${params.label}: only uppercase base32 characters (A–Z, digits 2–7) are allowed`,
    )
    .refine(
      (value) => params.check(value),
      `Invalid Stellar ${params.label}: the value's checksum does not match its contents`,
    );
}

/**
 * Standard Stellar Ed25519 public key (account address), e.g. `G…` (56 chars).
 */
export const stellarEd25519PublicKeySchema = buildStrKeySchema({
  prefix: 'G',
  label: 'Ed25519 public key',
  length: STELLAR_PUBLIC_KEY_LENGTH,
  check: (value) => StrKey.isValidEd25519PublicKey(value),
});

/**
 * Stellar contract id (Soroban / contract address), e.g. `C…` (56 chars).
 */
export const stellarContractIdSchema = buildStrKeySchema({
  prefix: 'C',
  label: 'contract ID',
  length: STELLAR_CONTRACT_ID_LENGTH,
  check: (value) => StrKey.isValidContract(value),
});

/**
 * Stellar multiplexed address (M…), which embeds a memo id (69 chars). Accepted
 * where a payment destination may be a multiplexed account.
 */
export const stellarMed25519PublicKeySchema = buildStrKeySchema({
  prefix: 'M',
  label: 'multiplexed (M...) address',
  length: STELLAR_MED25519_PUBLIC_KEY_LENGTH,
  check: (value) => StrKey.isValidMed25519PublicKey(value),
});

/**
 * Any Stellar funding/wallet public key: Ed25519 (G…) or multiplexed (M…).
 * Payments may only target accounts, not contracts.
 */
export const stellarPublicKeySchema = z.union([
  stellarEd25519PublicKeySchema,
  stellarMed25519PublicKeySchema,
]);

/**
 * Any Stellar address accepted by the API: public keys (G… / M…) or contract
 * IDs (C…). Use for general address fields (e.g. wallet import).
 */
export const stellarAddressSchema = z.union([
  stellarEd25519PublicKeySchema,
  stellarMed25519PublicKeySchema,
  stellarContractIdSchema,
]);

export type StellarAddress = z.infer<typeof stellarAddressSchema>;
export type StellarPublicKey = z.infer<typeof stellarPublicKeySchema>;