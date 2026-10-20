import { z } from 'zod';

/**
 * Per-asset limit overrides. A policy may declare tighter (or looser) limits
 * for a specific asset than the policy-wide limits. Keys are upper-case asset
 * codes (`XLM`, `USDC`); an issued asset (`USDC:GA5Z…`) matches the `USDC`
 * entry because only the code is compared.
 */
export const assetLimitSchema = z
  .object({
    maxAmount: z.number().nonnegative().optional(),
    minAmount: z.number().nonnegative().optional(),
    dailyLimit: z.number().nonnegative().optional(),
    weeklyLimit: z.number().nonnegative().optional(),
    monthlyLimit: z.number().nonnegative().optional(),
  })
  .strict();

/** Map of upper-case asset code to its limit overrides. */
export const assetLimitsSchema = z.record(z.string().min(1).max(12), assetLimitSchema);

/**
 * The JSONB `configuration` shape stored on a Policy. A single flexible object
 * lets us support many policy types (max/min amount, asset allow/block,
 * recipient allow/block, periodic budgets, time windows, approval) without
 * schema migrations. All fields are optional; the engine only enforces those
 * that are present.
 */
export const policyConfigurationSchema = z
  .object({
    maxAmount: z.number().nonnegative().optional(),
    minAmount: z.number().nonnegative().optional(),
    allowedAssets: z.array(z.string()).optional(),
    blockedAssets: z.array(z.string()).optional(),
    allowedRecipients: z.array(z.string()).optional(),
    blockedRecipients: z.array(z.string()).optional(),
    dailyLimit: z.number().nonnegative().optional(),
    weeklyLimit: z.number().nonnegative().optional(),
    monthlyLimit: z.number().nonnegative().optional(),
    /** Allowed hour-of-day window in UTC, inclusive start, exclusive end (0-24). */
    timeWindow: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(1).max(24),
        days: z.array(z.number().int().min(0).max(6)).optional(),
      })
      .strict()
      .optional(),
    requiresApproval: z.boolean().optional(),
    /** Any transaction at or above this amount forces an approval proposal. */
    approvalThreshold: z.number().nonnegative().optional(),
    /** When true, blocks ALL spending (emergency lock / kill switch). */
    emergencyLock: z.boolean().optional(),
    /** Per-asset limit overrides keyed by the upper-case asset code. */
    assetLimits: assetLimitsSchema.optional(),
    /**
     * Base currency the amount limits above are denominated in (e.g. `USD`).
     * When set, transfer amounts are converted into this currency before they
     * are compared with the limits.
     */
    baseCurrency: z.string().min(1).max(12).optional(),
  })
  .strict();

/**
 * Enhanced schema validation for policy configurations with structural integrity checks.
 * This provides more detailed validation and contextual error messages for policy configuration issues.
 */
export const policyConfigurationSchemaStrict = z
  .object({
    maxAmount: z.number().nonnegative().optional(),
    minAmount: z.number().nonnegative().optional(),
    allowedAssets: z.array(z.string().min(1).max(12)).optional(),
    blockedAssets: z.array(z.string().min(1).max(12)).optional(),
    allowedRecipients: z.array(z.string().min(1)).optional(),
    blockedRecipients: z.array(z.string().min(1)).optional(),
    dailyLimit: z.number().positive().optional(),
    weeklyLimit: z.number().positive().optional(),
    monthlyLimit: z.number().positive().optional(),
    /** Allowed hour-of-day window in UTC, inclusive start, exclusive end (0-24). */
    timeWindow: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(1).max(24),
        days: z.array(z.number().int().min(0).max(6)).optional(),
      })
      .strict()
      .refine(
        (data) => !data.days || data.days.length > 0,
        { message: 'timeWindow.days must not be empty when provided' },
      )
      .refine(
        (data) => data.startHour < data.endHour,
        { message: 'timeWindow.startHour must be less than timeWindow.endHour' },
      )
      .optional(),
    requiresApproval: z.boolean().optional(),
    /** Any transaction at or above this amount forces an approval proposal. */
    approvalThreshold: z.number().nonnegative().optional(),
    /** When true, blocks ALL spending (emergency lock / kill switch). */
    emergencyLock: z.boolean().optional(),
    /** Per-asset limit overrides keyed by the upper-case asset code. */
    assetLimits: assetLimitsSchema.optional(),
    /**
     * Base currency the amount limits above are denominated in (e.g. `USD`).
     * When set, transfer amounts are converted into this currency before they
     * are compared with the limits.
     */
    baseCurrency: z.string().min(1).max(12).optional(),
  })
  .strict()
  .refine(
    (data) => {
      // If both max and min amount are specified, max must be greater than min
      if (data.maxAmount !== undefined && data.minAmount !== undefined) {
        return data.maxAmount > data.minAmount;
      }
      return true;
    },
    { message: 'maxAmount must be greater than minAmount when both are specified' },
  )
  .refine(
    (data) => {
      // Cannot have both allowed and blocked assets for the same asset
      if (data.allowedAssets && data.blockedAssets) {
        const intersection = data.allowedAssets.filter((asset) =>
          data.blockedAssets!.includes(asset),
        );
        return intersection.length === 0;
      }
      return true;
    },
    { message: 'Asset cannot be both in allowedAssets and blockedAssets' },
  )
  .refine(
    (data) => {
      // Cannot have both allowed and blocked recipients for the same address
      if (data.allowedRecipients && data.blockedRecipients) {
        const intersection = data.allowedRecipients.filter((recipient) =>
          data.blockedRecipients!.includes(recipient),
        );
        return intersection.length === 0;
      }
      return true;
    },
    { message: 'Recipient cannot be both in allowedRecipients and blockedRecipients' },
  )
  .refine(
    (data) => {
      // If approvalThreshold is set, requiresApproval should typically be true
      if (data.approvalThreshold !== undefined && data.approvalThreshold > 0) {
        return data.requiresApproval === true;
      }
      return true;
    },
    { message: 'approvalThreshold requires requiresApproval to be true' },
  )
  .refine(
    (data) => {
      // A per-asset limit must not contradict itself either.
      if (!data.assetLimits) return true;
      return Object.values(data.assetLimits).every((limits) => {
        if (limits.maxAmount !== undefined && limits.minAmount !== undefined) {
          return limits.maxAmount > limits.minAmount;
        }
        return true;
      });
    },
    { message: 'assetLimits[].maxAmount must be greater than assetLimits[].minAmount when both are specified' },
  );

export type PolicyConfiguration = z.infer<typeof policyConfigurationSchema>;

/** Per-asset limit overrides stored on a policy. */
export type AssetLimitConfiguration = z.infer<typeof assetLimitSchema>;

/**
 * One asset leg of a transaction. A single-asset transaction has exactly one
 * leg; a multi-asset transfer has one leg per asset.
 */
export interface AssetTransfer {
  /** Canonical asset identifier of the leg (`XLM` or `CODE:ISSUER`). */
  asset: string;
  /**
   * Amount of the leg, expressed in the unit the limits are denominated in
   * (the asset's own unit, or the base currency when the policy declares one).
   */
  amount: number;
  /** Optional per-leg recipient; falls back to the intent recipient. */
  recipientAddress?: string;
}

/** Spend already made in each period, for one asset. */
export interface SpendPeriods {
  spentToday: number;
  spentThisWeek: number;
  spentThisMonth: number;
}

/** The transaction intent evaluated against policies. */
export interface TransactionIntent {
  organizationId: string;
  agentId?: string;
  walletId?: string;
  asset: string;
  amount: number;
  recipientAddress: string;
  /** Evaluation time; defaults to now. Injectable for deterministic tests. */
  at?: Date;
  /** Spend already made in each period, for budget-style policies. */
  spentToday?: number;
  spentThisWeek?: number;
  spentThisMonth?: number;
  /**
   * Multi-asset legs. When present they replace the single `asset`/`amount`
   * pair: every leg is evaluated against the policy limits independently.
   */
  transfers?: AssetTransfer[];
  /**
   * Spend already made per asset, keyed by the canonical asset identifier.
   * When present it takes precedence over the flat period fields.
   */
  spentByAsset?: Record<string, SpendPeriods>;
  /**
   * Currency the amounts in this intent are denominated in. Set by the
   * evaluation layer when a policy declares a `baseCurrency` and the amounts
   * had to be converted; used in violation messages.
   */
  limitCurrency?: string;
}

export interface PolicyViolation {
  policyId: string;
  policyName: string;
  code: string;
  message: string;
  /** Upper-case asset code the violation was raised for, when asset-specific. */
  asset?: string;
}

export interface PolicyEvaluationResult {
  passed: boolean;
  requiresApproval: boolean;
  violations: PolicyViolation[];
  /** Ids of the policies that were considered during evaluation. */
  evaluatedPolicyIds: string[];
  /** The highest-priority policy that matched, if any. */
  matchedPolicyId?: string;
}

/** Minimal projection of a Policy row the engine needs — decoupled from Prisma. */
export interface EvaluablePolicy {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  agentId?: string | null;
  configuration: PolicyConfiguration;
  // Temporary spending override (issue #21). While overrideUntil is in the
  // future the max-amount check uses overrideLimit; on expiry it falls back to
  // originalLimit (or the configured maxAmount).
  overrideLimit?: number | null;
  overrideUntil?: Date | null;
  originalLimit?: number | null;
}
