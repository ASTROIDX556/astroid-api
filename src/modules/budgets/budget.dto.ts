import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BudgetPeriod } from '@prisma/client';

const amountString = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, 'Amount must be a positive decimal with up to 7 places');

export const createBudgetSchema = z
  .object({
    name: z.string().min(1).max(120),
    currency: z.string().min(1).max(12).default('USDC'),
    limitAmount: amountString,
    period: z.nativeEnum(BudgetPeriod).default(BudgetPeriod.MONTHLY),
    rollover: z.boolean().default(false),
    parentBudgetId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

export const updateBudgetSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    limitAmount: amountString.optional(),
    period: z.nativeEnum(BudgetPeriod).optional(),
    rollover: z.boolean().optional(),
    enabled: z.boolean().optional(),
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

  @ApiPropertyOptional({ example: false, description: 'Whether the unused amount rolls into the next period' })
  rollover?: boolean;

  @ApiPropertyOptional({ description: 'Parent budget for hierarchical allocation' })
  parentBudgetId?: string;

  @ApiPropertyOptional({ description: 'Restrict the budget to a single agent', example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
  agentId?: string;

  @ApiPropertyOptional({ example: true, description: 'Whether the budget is enforced' })
  enabled?: boolean;
}

export class AllocateBudgetDto {
  @ApiProperty({ example: '250.0000000', description: 'Amount moved from the parent budget' })
  amount!: string;
}
