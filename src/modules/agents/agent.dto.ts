import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentRole, AgentStatus } from '@prisma/client';
import { stellarEd25519PublicKeySchema } from '../../common/validators/stellar-address.schema';

/** Maximum number of capabilities an agent may declare. */
export const MAX_AGENT_CAPABILITIES = 50;

/**
 * The agent's display name. It doubles as the agent handle inside an
 * organization — handles are unique per organization — so the value is
 * normalized (trimmed) and must not be empty.
 */
export const agentNameSchema = z
  .string({
    required_error: 'Agent name is required',
    invalid_type_error: 'Agent name must be a string',
  })
  .trim()
  .min(1, 'Agent name must not be empty')
  .max(120, 'Agent name must be at most 120 characters');

/** A single capability label. */
export const agentCapabilitySchema = z
  .string({
    invalid_type_error: 'Capability must be a string',
  })
  .trim()
  .min(1, 'Capability must not be empty')
  .max(80, 'Capability must be at most 80 characters');

/** The declared capabilities of an agent: bounded, trimmed and unique. */
export const agentCapabilitiesSchema = z
  .array(agentCapabilitySchema)
  .max(MAX_AGENT_CAPABILITIES, `An agent may declare at most ${MAX_AGENT_CAPABILITIES} capabilities`)
  .refine((capabilities) => new Set(capabilities).size === capabilities.length, {
    message: 'Capabilities must be unique',
  })
  .default(() => []);

/** Free-form metadata attached to an agent. */
export const agentMetadataSchema = z.record(z.unknown()).default(() => ({}));

/**
 * Creation payload of an agent.
 *
 * The schema is strict: unknown keys are rejected so a typo in a payload
 * never reaches the Prisma repository silently.
 */
export const createAgentSchema = z
  .object({
    name: agentNameSchema,
    description: z.string().trim().max(500, 'Description must be at most 500 characters').optional(),
    provider: z.string().trim().max(80, 'Provider must be at most 80 characters').optional(),
    model: z.string().trim().max(80, 'Model must be at most 80 characters').optional(),
    role: z.nativeEnum(AgentRole).default(AgentRole.CUSTOM),
    capabilities: agentCapabilitiesSchema,
    metadata: agentMetadataSchema,
    /**
     * Optional Stellar Ed25519 public key the agent signs with. Validated
     * against the Stellar strkey checksum so a malformed key is rejected at
     * the API boundary instead of failing later on-chain.
     */
    publicKey: stellarEd25519PublicKeySchema.optional(),
  })
  .strict();
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

/** Partial update payload of an agent. */
export const updateAgentSchema = createAgentSchema.partial();
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

export const assignWalletSchema = z.object({
  walletId: z.string().uuid('Wallet id must be a valid UUID'),
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

  @ApiPropertyOptional({
    description:
      'Stellar Ed25519 public key (G…) the agent signs with. Validated against the Stellar checksum.',
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  })
  publicKey?: string;
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
