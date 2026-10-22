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
  @ApiProperty({ example: 'Q3 Marketing' })
  name!: string;

  @ApiPropertyOptional({ example: 'USDC' })
  currency?: string;

  @ApiProperty({ example: '10000.0000000' })
  limitAmount!: string;

  @ApiPropertyOptional({ enum: BudgetPeriod, example: BudgetPeriod.MONTHLY })
  period?: BudgetPeriod;

  @ApiPropertyOptional({ type: Boolean, example: false })
  rollover?: boolean;

  @ApiPropertyOptional({ description: 'Parent budget UUID for hierarchical allocation', format: 'uuid' })
  parentBudgetId?: string;

  @ApiPropertyOptional({ description: 'Agent UUID', format: 'uuid' })
  agentId?: string;

  @ApiPropertyOptional({ type: Boolean, example: true })
  enabled?: boolean;
}

export class AllocateBudgetDto {
  @ApiProperty({ example: '250.0000000' })
  amount!: string;
}
