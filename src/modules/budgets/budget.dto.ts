import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BudgetCarryOverRule, BudgetPeriod } from '@prisma/client';
import { isValidTimezone } from './utils/period.util';

const timezone = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimezone, 'Must be a valid IANA timezone (e.g. Africa/Lagos)');

const carryOverRule = z.nativeEnum(BudgetCarryOverRule).default(BudgetCarryOverRule.NONE);

const amountString = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, 'Amount must be a positive decimal with up to 7 places');

/**
 * Per-budget override of the percentage thresholds that emit budget alerts.
 * Strictly ascending, each in `(0, 100]`, and capped so one budget cannot make
 * the spend path evaluate an unbounded list. Empty/omitted means "use the
 * global BUDGET_ALERT_THRESHOLDS".
 */
const alertThresholds = z
  .array(
    z
      .number()
      .int('Thresholds must be whole percentages')
      .gt(0, 'Thresholds must be greater than 0')
      .lte(100, 'Thresholds must be at most 100'),
  )
  .max(20, 'At most 20 thresholds are allowed')
  .refine(
    (values) => values.every((value, index) => index === 0 || value > values[index - 1]),
    'Thresholds must be strictly ascending',
  )
  .optional();

export const createBudgetSchema = z
  .object({
    name: z.string().min(1).max(120),
    currency: z.string().min(1).max(12).default('USDC'),
    limitAmount: amountString,
    period: z.nativeEnum(BudgetPeriod).default(BudgetPeriod.MONTHLY),
    // A budget's window is anchored at creation; the scheduled rollover advances
    // it from there in the budget's timezone.
    periodStart: z.coerce.date().optional(),
    timezone: timezone.default('UTC'),
    carryOverRule,
    rollover: z.boolean().default(false),
    parentBudgetId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
    enabled: z.boolean().default(true),
    alertThresholds,
  })
  .strict();
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

export const updateBudgetSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    limitAmount: amountString.optional(),
    period: z.nativeEnum(BudgetPeriod).optional(),
    timezone: timezone.optional(),
    carryOverRule: z.nativeEnum(BudgetCarryOverRule).optional(),
    rollover: z.boolean().optional(),
    enabled: z.boolean().optional(),
    alertThresholds,
  })
  .strict();
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

export const allocateBudgetSchema = z
  .object({
    amount: amountString,
  })
  .strict();
export type AllocateBudgetInput = z.infer<typeof allocateBudgetSchema>;

// ── Swagger DTOs ──

export class CreateBudgetDto {
  @ApiProperty({ example: 'Q3 Marketing', description: 'Name of the budget' })
  name!: string;

  @ApiPropertyOptional({ example: 'USDC', description: 'Asset the budget is denominated in' })
  currency?: string;

  @ApiProperty({ example: '10000.0000000', description: 'Maximum amount that can be spent in the period' })
  limitAmount!: string;

  @ApiPropertyOptional({ enum: BudgetPeriod, description: 'How often the budget resets', example: BudgetPeriod.MONTHLY })
  period?: BudgetPeriod;

  @ApiPropertyOptional({
    enum: BudgetCarryOverRule,
    default: BudgetCarryOverRule.NONE,
    description:
      'Carry-over applied at period close: NONE resets spend, UNUSED carries a positive remainder, OVERSPEND carries a negative balance, NET carries both',
  })
  carryOverRule?: BudgetCarryOverRule;

  @ApiPropertyOptional({
    example: 'UTC',
    description: 'IANA timezone used to compute period boundaries',
  })
  timezone?: string;

  @ApiPropertyOptional({
    example: '2026-01-01T00:00:00.000Z',
    description: 'Anchor instant of the first period; defaults to creation time',
  })
  periodStart?: string;

  @ApiPropertyOptional({ example: false, description: 'Legacy flag; carryOverRule controls scheduled rollover' })
  rollover?: boolean;

  @ApiPropertyOptional({ description: 'Parent budget UUID for hierarchical allocation', format: 'uuid' })
  parentBudgetId?: string;

  @ApiPropertyOptional({ description: 'Restrict the budget to a single agent', example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
  agentId?: string;

  @ApiPropertyOptional({ example: true, description: 'Whether the budget is enforced' })
  enabled?: boolean;

  @ApiPropertyOptional({
    type: [Number],
    example: [50, 90],
    description:
      'Percentage thresholds (strictly ascending, 1-100) that emit a budget.threshold_reached ' +
      'event once per period. Omit or send [] to use the global BUDGET_ALERT_THRESHOLDS list.',
  })
  alertThresholds?: number[];
}

export class AllocateBudgetDto {
  @ApiProperty({ example: '250.0000000', description: 'Amount moved from the parent budget' })
  amount!: string;
}
