import { z } from 'zod';
import { stellarAddressSchema } from '../../../common/validators/stellar-address.schema';

/**
 * Zod schema for a Stellar/Soroban pre-flight simulation request.
 *
 * Two mutually-compatible invocation modes are supported:
 *   1. Soroban contract simulation — supply a base64 `transactionXdr`.
 *   2. Classic payment pre-flight — supply `source`, `destination`, `amount`
 *      and `asset` (a XDR is built and assessed for fee/account health).
 */
export const stellarSimulationRequestSchema = z
  .object({
    /** Network to simulate against. */
    network: z.enum(['public', 'testnet', 'futurenet']).default('testnet'),
    /** Optional base64-encoded transaction envelope XDR (Soroban/contract). */
    transactionXdr: z.string().optional(),
    /** Source Stellar account (for classic payment pre-flight). */
    source: stellarAddressSchema.optional(),
    /** Destination Stellar account (for classic payment pre-flight). */
    destination: stellarAddressSchema.optional(),
    /** Amount to send (classic payment pre-flight). */
    amount: z
      .string()
      .regex(/^\d+(\.\d{1,7})?$/, 'Amount must be a positive decimal with up to 7 places')
      .optional(),
    /** Asset code (defaults to XLM). */
    asset: z.string().max(24).default('XLM'),
    /** Optional memo. */
    memo: z.string().max(28).optional(),
    /** Maximum acceptable resource fee in stroops; simulation warns if exceeded. */
    maxFeeStroops: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Require either an XDR (contract) OR the classic payment fields.
    const hasXdr = Boolean(data.transactionXdr);
    const hasPayment =
      Boolean(data.source) && Boolean(data.destination) && Boolean(data.amount);
    if (!hasXdr && !hasPayment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide either a transactionXdr (Soroban simulation) or source, destination and amount (classic payment pre-flight)',
      });
    }
  });

export type StellarSimulationRequest = z.input<typeof stellarSimulationRequestSchema>;

/**
 * Structured pre-flight validation report returned to callers.
 * Provides a success probability, fee estimate, resource cost, footprint,
 * events and a list of warnings / hard failure reasons.
 */
export interface StellarSimulationReport {
  /** Whether the transaction is considered safe to submit. */
  isSafeToSubmit: boolean;
  /** 0-100 heuristic probability the transaction will succeed. */
  successProbability: number;
  /** Estimated resource fee in stroops. */
  feeEstimateStroops: string;
  /** Whether the estimated fee is within the caller's (or default) bound. */
  feeWithinBound: boolean;
  /** 0-100 computed "confidence" used to derive success probability. */
  confidence: number;
  /** Resource cost analysis (present for Soroban simulations). */
  cost?: {
    cpuInstructions: number;
    memoryBytes: number;
  };
  /** Accepted keys footprint (present for Soroban simulations). */
  footprint?: {
    readOnly: Array<{ contractId: string; key: unknown }>;
    readWrite: Array<{ contractId: string; key: unknown }>;
  };
  /** Contract events emitted during simulation (present for Soroban). */
  events?: Array<{ type: string; contractId: string; topic: string[]; value: unknown }>;
  /** Warnings — non-blocking concerns worth surfacing to the caller. */
  warnings: string[];
  /** Hard failure reasons — if non-empty the transaction should not be submitted. */
  failureReasons: string[];
  /** Whether this report was produced from a circuit-breaker fallback (degraded). */
  isFallback: boolean;
  /** Transaction hash from the simulation, if available. */
  transactionHash?: string;
  /** The maximum accepted fee used for the bound check (stroops). */
  maxFeeStroops: number;
}

/**
 * Summary type describing why a classic pre-flight succeeded/failed.
 */
export interface ClassicPreFlightSummary {
  accountExists: boolean;
  nativeBalanceStroops?: string;
  sufficientForFeeAndAmount?: boolean;
}
