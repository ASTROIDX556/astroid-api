import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentRole, AgentStatus } from '@prisma/client';

export const createAgentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  provider: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  role: z.nativeEnum(AgentRole).default(AgentRole.CUSTOM),
  capabilities: z.array(z.string().max(80)).max(50).default([]),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = createAgentSchema.partial();
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

export const assignWalletSchema = z.object({
  walletId: z.string().uuid(),
});
export type AssignWalletInput = z.infer<typeof assignWalletSchema>;

// ── Swagger DTOs (documentation only; validation is done by Zod pipes) ──

export class CreateAgentDto {
  @ApiProperty({
    example: 'Procurement Bot',
    description: 'Human-readable name for the agent',
    minLength: 1,
    maxLength: 120,
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Detailed description of the agent\'s purpose',
    maxLength: 500,
  })
  description?: string;

  @ApiPropertyOptional({
    example: 'openai',
    description: 'AI provider (e.g., openai, anthropic)',
    maxLength: 80,
  })
  provider?: string;

  @ApiPropertyOptional({
    example: 'gpt-4o',
    description: 'Model identifier',
    maxLength: 80,
  })
  model?: string;

  @ApiPropertyOptional({
    enum: AgentRole,
    enumName: 'AgentRole',
    description: 'Functional role of the agent',
    example: 'PROCUREMENT',
  })
  role?: AgentRole;

  @ApiPropertyOptional({
    type: [String],
    example: ['payments', 'reporting'],
    description: 'List of agent capabilities',
    maxItems: 50,
  })
  capabilities?: string[];

  @ApiPropertyOptional({
    type: Object,
    description: 'Additional metadata as key-value pairs',
  })
  metadata?: Record<string, unknown>;
}

export class AssignWalletDto {
  @ApiProperty({
    description: 'The wallet to set as the agent primary wallet',
    format: 'uuid',
  })
  walletId!: string;
}

export class UpdateAgentStatusDto {
  @ApiProperty({
    enum: AgentStatus,
    description: 'New status for the agent',
    enumName: 'AgentStatus',
  })
  status!: AgentStatus;
}

export class AgentResponseDto {
  @ApiProperty({ description: 'Agent UUID', format: 'uuid', example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b' })
  id!: string;

  @ApiProperty({ description: 'Organization UUID', format: 'uuid', example: '018f0a1b-0000-4000-8000-000000000000' })
  organizationId!: string;

  @ApiPropertyOptional({ description: 'Primary wallet UUID', format: 'uuid' })
  primaryWalletId?: string;

  @ApiProperty({ description: 'Agent name', example: 'Procurement Bot' })
  name!: string;

  @ApiPropertyOptional({ description: 'Agent description', example: 'Renegotiates supplier contracts' })
  description?: string;

  @ApiPropertyOptional({ description: 'AI provider', example: 'openai' })
  provider?: string;

  @ApiPropertyOptional({ description: 'AI model', example: 'gpt-4o' })
  model?: string;

  @ApiProperty({ enum: AgentRole, description: 'Agent role', example: AgentRole.PROCUREMENT })
  role!: AgentRole;

  @ApiProperty({ enum: AgentStatus, description: 'Current agent status', example: AgentStatus.ACTIVE })
  status!: AgentStatus;

  @ApiProperty({
    type: [String],
    description: 'Agent capabilities',
    example: ['payments', 'reporting'],
  })
  capabilities!: string[];

  @ApiProperty({
    type: Object,
    description: 'Agent metadata',
    example: { rateLimit: 5 },
  })
  metadata!: Record<string, unknown>;

  @ApiProperty({ description: 'Agent creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ description: 'Last update timestamp', example: '2026-01-16T08:00:00.000Z' })
  updatedAt!: Date;
}

/** The acknowledgement returned when an agent execution is requested. */
export class AgentExecutionDto {
  @ApiProperty({ description: 'Whether the execution was accepted', example: true })
  success!: boolean;

  @ApiProperty({ description: 'Human-readable confirmation', example: 'Execution triggered' })
  message!: string;
}
