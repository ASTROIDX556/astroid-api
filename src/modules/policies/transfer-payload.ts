import { z } from 'zod';
import { stellarAssetSchema } from '../../common/validators/stellar-asset.schema';

/**
 * One asset leg of a transfer payload. The amount is a decimal string with up
 * to 7 places, matching Stellar's precision.
 */
export const assetTransferSchema = z.object({
  asset: stellarAssetSchema,
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/, 'Amount must be a positive decimal with up to 7 places')
    .refine((value) => Number(value) > 0, 'Amount must be greater than zero'),
});

export type AssetTransferInput = z.infer<typeof assetTransferSchema>;

/** A transfer leg after parsing, with the amount as a number. */
export interface ParsedTransfer {
  /** Canonical asset identifier (`XLM` or `CODE:ISSUER`). */
  asset: string;
  /** Amount of the leg. */
  amount: number;
  /** Optional per-leg recipient, when the payload declares one. */
  recipientAddress?: string;
}

/** The raw shape a payload may have before it is parsed. */
export interface TransferPayloadInput {
  asset?: string;
  amount?: string | number;
  transfers?: Array<{ asset: string; amount: string | number; recipientAddress?: string }>;
}

/** Raised when a transfer payload cannot be parsed. */
export class TransferPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferPayloadError';
  }
}

/**
 * Parses a single-asset or multi-asset transfer payload into its legs.
 *
 * - A payload with a `transfers` array is a multi-asset transfer: one leg per
 *   entry. Every asset may appear at most once, so a transfer can never hide
 *   two amounts for the same asset behind a single limit check.
 * - A payload with a top-level `asset`/`amount` pair is a single-asset
 *   transfer and yields exactly one leg.
 *
 * @param canonicalize Resolves an asset string to its canonical identifier.
 * @throws TransferPayloadError when the payload is malformed.
 */
export function parseTransferPayload(
  input: TransferPayloadInput,
  canonicalize: (asset: string) => string,
): ParsedTransfer[] {
  if (input.transfers && input.transfers.length > 0) {
    const seen = new Set<string>();
    return input.transfers.map((leg) => {
      const asset = canonicalize(leg.asset);
      const key = asset.toUpperCase();
      if (seen.has(key)) {
        throw new TransferPayloadError(
          `Duplicate asset '${asset}' in transfers; each asset may appear only once per payload`,
        );
      }
      seen.add(key);
      return {
        asset,
        amount: parseAmount(leg.amount),
        ...(leg.recipientAddress ? { recipientAddress: leg.recipientAddress } : {}),
      };
    });
  }

  if (input.asset === undefined || input.amount === undefined) {
    throw new TransferPayloadError(
      'A transfer payload requires either an asset/amount pair or a transfers array',
    );
  }

  return [
    {
      asset: canonicalize(input.asset),
      amount: parseAmount(input.amount),
    },
  ];
}

/** Parses a transfer amount into a finite positive number. */
function parseAmount(value: string | number): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TransferPayloadError('Amount must be a finite number greater than zero');
  }
  return amount;
}
