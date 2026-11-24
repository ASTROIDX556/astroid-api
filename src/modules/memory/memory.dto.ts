import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const createMemorySchema = z
  .object({
    agentId: z.string().uuid().optional(),
    transactionId: z.string().uuid().optional(),
    task: z.string().max(280).optional(),
    reason: z.string().max(2000).optional(),
    conversationId: z.string().max(120).optional(),
    policyUsed: z.string().max(120).optional(),
    risk: z.number().int().min(0).max(100).optional(),
    summary: z.string().max(2000).optional(),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;

// ── Swagger DTOs ──

export class CreateMemoryDto {
  @ApiPropertyOptional({
    description: 'Agent the record belongs to',
    example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
  })
  agentId?: string;

  @ApiPropertyOptional({
    description: 'Transaction the record was written for',
    example: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
  })
  transactionId?: string;

  @ApiPropertyOptional({ example: 'Pay invoice #4521', description: 'Task the agent was working on' })
  task?: string;

  @ApiPropertyOptional({
    example: 'Vendor is a known recipient; amount within monthly budget.',
    description: 'Why the agent acted',
  })
  reason?: string;

  @ApiPropertyOptional({
    description: 'Conversation the record belongs to',
    example: 'conv_018f...',
  })
  conversationId?: string;

  @ApiPropertyOptional({
    description: 'Policy that was applied',
    example: 'Max 1000 USDC per transaction',
  })
  policyUsed?: string;

  @ApiPropertyOptional({
    description: 'Risk score at the time of the decision',
    minimum: 0,
    maximum: 100,
    example: 24,
  })
  risk?: number;

  @ApiPropertyOptional({
    description: 'Short summary of the record',
    example: 'Invoice paid after review',
  })
  summary?: string;

  @ApiPropertyOptional({ type: Object, description: 'Free-form metadata stored with the record' })
  metadata?: Record<string, unknown>;
}


/** A financial memory record as returned by the API. */
export class MemoryRecordDto {
  @ApiProperty({ description: 'Memory record id', format: 'uuid', example: '018f0a1b-6666-4000-8000-000000000000' })
  id!: string;

  @ApiPropertyOptional({ description: 'Agent the record belongs to', format: 'uuid' })
  agentId?: string;

  @ApiPropertyOptional({ description: 'Transaction the record was written for', format: 'uuid' })
  transactionId?: string;

  @ApiPropertyOptional({ description: 'Task the agent was working on', example: 'Reconcile supplier invoice' })
  task?: string;

  @ApiPropertyOptional({ description: 'Why the agent acted', example: 'Invoice exceeded the agreed amount' })
  reason?: string;

  @ApiPropertyOptional({ description: 'Conversation the record belongs to', example: 'conv_018f...' })
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Policy that was applied', example: 'Max 1000 USDC per transaction' })
  policyUsed?: string;

  @ApiPropertyOptional({ description: 'Risk score recorded with the memory', example: 24 })
  risk?: number;

  @ApiPropertyOptional({ description: 'Short summary of the record', example: 'Invoice paid after review' })
  summary?: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}
