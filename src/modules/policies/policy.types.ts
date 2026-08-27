import { z } from 'zod';

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
      .optional(),
    requiresApproval: z.boolean().optional(),
    /** Any transaction at or above this amount forces an approval proposal. */
    approvalThreshold: z.number().nonnegative().optional(),
    /** When true, blocks ALL spending (emergency lock / kill switch). */
    emergencyLock: z.boolean().optional(),
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
    { message: 'limits.maxAmount must be greater than limits.minAmount when both are specified' },
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
  );

export type PolicyConfiguration = z.infer<typeof policyConfigurationSchema>;

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
}

export interface PolicyViolation {
  policyId: string;
  policyName: string;
  code: string;
  message: string;
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
