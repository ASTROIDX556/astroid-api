import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PolicyType } from '@prisma/client';
import { policyConfigurationSchemaStrict } from './policy.types';

export const createPolicySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  type: z.nativeEnum(PolicyType),
  agentId: z.string().uuid().optional(),
  configuration: policyConfigurationSchemaStrict.default({}),
  priority: z.number().int().min(0).max(1000).default(100),
  enabled: z.boolean().default(true),
});

export type CreatePolicyInput = z.infer<typeof createPolicySchema>;

export const updatePolicySchema = createPolicySchema.partial();
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

export const simulatePolicySchema = z.object({
  agentId: z.string().uuid().optional(),
  walletId: z.string().uuid().optional(),
  asset: z.string().min(1),
  amount: z.number().positive(),
  recipientAddress: z.string().min(1),
  spentToday: z.number().nonnegative().optional(),
  spentThisWeek: z.number().nonnegative().optional(),
  spentThisMonth: z.number().nonnegative().optional(),
});

export type SimulatePolicyInput = z.infer<typeof simulatePolicySchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class CreatePolicyDto {
  @ApiProperty({ example: 'Max 1000 USDC per transaction' })
  name!: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty({ enum: PolicyType })
  type!: PolicyType;

  @ApiPropertyOptional({ description: 'Scope the policy to a single agent' })
  agentId?: string;

  @ApiProperty({
    example: { maxAmount: 1000, allowedAssets: ['USDC'], requiresApproval: true },
  })
  configuration!: Record<string, unknown>;

  @ApiPropertyOptional({ example: 100 })
  priority?: number;

  @ApiPropertyOptional({ example: true })
  enabled?: boolean;
}

export class SimulatePolicyDto {
  @ApiPropertyOptional()
  agentId?: string;

  @ApiProperty({ example: 'USDC' })
  asset!: string;

  @ApiProperty({ example: 500 })
  amount!: number;

  @ApiProperty({ example: 'GABC...' })
  recipientAddress!: string;
}
