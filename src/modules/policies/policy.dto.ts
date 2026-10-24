import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PolicyType } from '@prisma/client';
import { policyConfigurationSchemaStrict } from './policy.types';

export const createPolicySchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    type: z.nativeEnum(PolicyType),
    agentId: z.string().uuid().optional(),
    configuration: policyConfigurationSchemaStrict.default({}),
    priority: z.number().int().min(0).max(1000).default(100),
    enabled: z.boolean().default(true),
  })
  .strict();

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
  /** Transactions already executed in the velocity window. */
  transactionCount: z.number().int().nonnegative().optional(),
  /** Transactions already executed per velocity window. */
  transactionCounts: z
    .record(
      z.enum(['minute', 'hour', 'day', 'week', 'month']),
      z.number().int().nonnegative(),
    )
    .optional(),
});

export type SimulatePolicyInput = z.infer<typeof simulatePolicySchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class CreatePolicyDto {
  @ApiProperty({ example: 'Max 1000 USDC per transaction', description: 'Human-readable name of the policy' })
  name!: string;

  @ApiPropertyOptional({ example: 'Caps a single transfer at 1000 USDC', description: 'What the policy enforces' })
  description?: string;

  @ApiProperty({ enum: PolicyType, description: 'Kind of rule the policy evaluates', example: PolicyType.MAX_AMOUNT })
  type!: PolicyType;

  @ApiPropertyOptional({ description: 'Scope the policy to a single agent', example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
  agentId?: string;

  @ApiProperty({
    example: { maxAmount: 1000, allowedAssets: ['USDC'], requiresApproval: true },
    description: 'Rule configuration — the accepted keys depend on the policy type',
  })
  configuration!: Record<string, unknown>;

  @ApiPropertyOptional({ example: 100, description: 'Evaluation order — lower numbers are evaluated first' })
  priority?: number;

  @ApiPropertyOptional({ example: true, description: 'Whether the policy is enforced' })
  enabled?: boolean;
}

export class SimulatePolicyDto {
  @ApiPropertyOptional({ description: 'Agent the hypothetical transaction belongs to', example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
  agentId?: string;

  @ApiProperty({ example: 'USDC', description: 'Asset of the hypothetical transaction' })
  asset!: string;

  @ApiProperty({ example: 500, description: 'Amount of the hypothetical transaction' })
  amount!: number;

  @ApiProperty({ example: 'GABC...', description: 'Destination address of the hypothetical transaction' })
  recipientAddress!: string;
}

/** The outcome of a policy simulation. */
export class PolicySimulationDto {
  @ApiProperty({ description: 'Whether every applicable policy would allow the transaction', example: true })
  passed!: boolean;

  @ApiProperty({ description: 'Whether the transaction would need a human approval', example: false })
  requiresApproval!: boolean;

  @ApiProperty({
    type: [String],
    description: 'Reasons the transaction was rejected',
    example: ['amount exceeds the 1000 USDC limit'],
  })
  violations!: string[];

  @ApiProperty({ description: 'Number of policies that were evaluated', example: 3 })
  evaluatedPolicies!: number;
}
