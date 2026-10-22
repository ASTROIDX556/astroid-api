import { z } from 'zod';

/**
 * The window a velocity rule is measured over.
 */
export const policyVelocityWindowSchema = z.enum(['minute', 'hour', 'day', 'week', 'month']);
export type PolicyVelocityWindow = z.infer<typeof policyVelocityWindowSchema>;

/**
 * A time window expressed in local time. `timezone` is an IANA identifier
 * (e.g. `Europe/Lisbon`); when it is omitted the window is interpreted in UTC.
 */
export const policyTimeWindowSchema = z
  .object({
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(1).max(24),
    days: z.array(z.number().int().min(0).max(6)).optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * Velocity rule: caps how many transactions may be executed inside a rolling
 * window, independently of the amount they move.
 */
export const policyVelocitySchema = z
  .object({
    maxTransactions: z.number().int().positive(),
    window: policyVelocityWindowSchema,
  })
  .strict();

/** Fields a rule condition can be evaluated against. */
export const policyRuleFieldSchema = z.enum([
  'amount',
  'asset',
  'recipientAddress',
  'agentId',
  'hourOfDay',
  'dayOfWeek',
  'transactionCount',
]);
export type PolicyRuleField = z.infer<typeof policyRuleFieldSchema>;

/** Comparison operators supported by a rule condition. */
export const policyRuleOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
]);
export type PolicyRuleOperator = z.infer<typeof policyRuleOperatorSchema>;

/** A single condition inside a rule group. */
export const policyRuleConditionSchema = z
  .object({
    field: policyRuleFieldSchema,
    operator: policyRuleOperatorSchema,
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  })
  .strict();

/**
 * A group of conditions that are combined with `AND` (all must hold) or `OR`
 * (at least one must hold). A group that does not hold produces a violation.
 */
export const policyRuleGroupSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    logic: z.enum(['AND', 'OR']).default('AND'),
    conditions: z.array(policyRuleConditionSchema).min(1).max(20),
  })
  .strict()
  .refine(
    (group) =>
      group.conditions.every((condition) =>
        condition.operator === 'in' || condition.operator === 'notIn'
          ? Array.isArray(condition.value)
          : !Array.isArray(condition.value),
      ),
    {
      message:
        'Conditions using the in/notIn operators require an array value; every other operator requires a scalar value',
    },
  );

export type PolicyRuleCondition = z.infer<typeof policyRuleConditionSchema>;
export type PolicyRuleGroup = z.infer<typeof policyRuleGroupSchema>;

/**
 * The JSONB `configuration` shape stored on a Policy. A single flexible object
 * lets us support many policy types (max/min amount, asset allow/block,
 * recipient allow/block, periodic budgets, time windows, velocity limits,
 * multi-condition rule groups, approval) without schema migrations. All fields
 * are optional; the engine only enforces those that are present.
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
    /** Allowed hour-of-day window, inclusive start, exclusive end (0-24). */
    timeWindow: policyTimeWindowSchema.optional(),
    /** Caps the number of transactions executed inside a rolling window. */
    velocity: policyVelocitySchema.optional(),
    /** Multi-condition rule groups evaluated together. */
    rules: z.array(policyRuleGroupSchema).optional(),
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
    /** Allowed hour-of-day window, inclusive start, exclusive end (0-24). */
    timeWindow: policyTimeWindowSchema
      .refine(
        (data) => !data.days || data.days.length > 0,
        { message: 'timeWindow.days must not be empty when provided' },
      )
      .refine(
        (data) => data.startHour < data.endHour,
        { message: 'timeWindow.startHour must be less than timeWindow.endHour' },
      )
      .optional(),
    /** Caps the number of transactions executed inside a rolling window. */
    velocity: policyVelocitySchema.optional(),
    /** Multi-condition rule groups evaluated together. */
    rules: z.array(policyRuleGroupSchema).max(20).optional(),
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
  /**
   * Number of transactions already executed inside the velocity window. Used
   * by the velocity rule to cap transaction frequency independently of the
   * amount they move.
   */
  transactionCount?: number;
  /**
   * Number of transactions already executed per velocity window. Preferred
   * over {@link TransactionIntent.transactionCount} when a policy declares
   * more than one velocity window.
   */
  transactionCounts?: Partial<Record<PolicyVelocityWindow, number>>;
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
