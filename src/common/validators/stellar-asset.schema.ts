import { z } from 'zod';
import { stellarEd25519PublicKeySchema } from './stellar-address.schema';
import { ASSET_CODE_MAX_LENGTH, isValidAssetCode } from '../../utils/asset.util';

/**
 * Zod contract for a Stellar asset identifier.
 *
 * Accepts either a bare ticker (`XLM`, `USDC`) or the canonical network form
 * `CODE:ISSUER` used for credit assets. The issuer, when present, must be a
 * valid Stellar account address (format *and* checksum).
 */
export const stellarAssetSchema = z
  .string({ invalid_type_error: 'Asset must be a string' })
  .trim()
  .min(1, 'Asset is required')
  .max(80, 'Asset must be at most 80 characters')
  .superRefine((value, ctx) => {
    const separator = value.indexOf(':');
    if (separator === -1) {
      if (!isValidAssetCode(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Asset code must be 1-${ASSET_CODE_MAX_LENGTH} alphanumeric characters`,
        });
      }
      return;
    }

    const code = value.slice(0, separator);
    const issuer = value.slice(separator + 1);
    if (!isValidAssetCode(code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Asset code must be 1-${ASSET_CODE_MAX_LENGTH} alphanumeric characters`,
      });
    }
    if (!stellarEd25519PublicKeySchema.safeParse(issuer).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Asset issuer must be a valid Stellar account address (G…)',
      });
    }
  });

export type StellarAsset = z.infer<typeof stellarAssetSchema>;
