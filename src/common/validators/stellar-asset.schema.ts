import { z } from 'zod';

/**
 * Stellar asset codes are 1–12 ASCII alphanumeric characters. The native asset
 * is represented by XLM; issued assets use the same code constraints and carry
 * their issuer separately in the Stellar SDK layer.
 */
export const stellarAssetCodeSchema = z
  .string({ invalid_type_error: 'Asset code must be a string' })
  .min(1, 'Asset code is required')
  .regex(/^[a-zA-Z0-9]+$/, 'Asset code must contain only ASCII letters and digits')
  .max(12, 'Asset code must be at most 12 characters');

export type StellarAssetCode = z.infer<typeof stellarAssetCodeSchema>;

/** Asset identifier accepted by transfer payloads: native/code or CODE:ISSUER. */
export const stellarAssetSchema = z.union([
  stellarAssetCodeSchema,
  z.string().regex(/^[a-zA-Z0-9]{1,12}:G[A-Z2-7]{55}$/, 'Issued asset must use CODE:ISSUER form'),
]);
