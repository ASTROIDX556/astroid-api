import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApprovalDecision } from '@prisma/client';

export const decideProposalSchema = z
  .object({
    decision: z.enum([ApprovalDecision.APPROVED, ApprovalDecision.REJECTED]),
    comment: z.string().max(500).optional(),
  })
  .strict();
export type DecideProposalInput = z.infer<typeof decideProposalSchema>;

// ── Swagger DTOs ──

export class DecideProposalDto {
  @ApiProperty({
    enum: [ApprovalDecision.APPROVED, ApprovalDecision.REJECTED],
    description: 'The decision to record',
    example: ApprovalDecision.APPROVED,
  })
  decision!: ApprovalDecision;

  @ApiPropertyOptional({ description: 'Optional reviewer note' })
  comment?: string;
}

export const decisionCommentSchema = z
  .object({
    comment: z.string().max(500).optional(),
  })
  .strict();
export type DecisionCommentInput = z.infer<typeof decisionCommentSchema>;

export class DecisionCommentDto {
  @ApiPropertyOptional({ description: 'Optional reviewer note' })
  comment?: string;
}

/** An approval proposal raised for a transaction that needs a sign-off. */
export class ProposalResponseDto {
  @ApiProperty({ description: 'Proposal id', format: 'uuid', example: '018f0a1b-3333-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Organization the proposal belongs to', format: 'uuid' })
  organizationId!: string;

  @ApiProperty({ description: 'Transaction the proposal approves', format: 'uuid' })
  transactionId!: string;

  @ApiProperty({ description: 'Title shown to the reviewers', example: 'Approval required for 125.5000000 USDC' })
  title!: string;

  @ApiPropertyOptional({ description: 'Description shown to the reviewers' })
  description?: string;

  @ApiProperty({ description: 'Kind of approval workflow', enum: ['SINGLE', 'DUAL', 'MULTISIG', 'ROLE', 'COMMITTEE', 'EMERGENCY'], example: 'DUAL' })
  approvalType!: string;

  @ApiProperty({ description: 'Number of approvals required before the transaction executes', example: 2 })
  requiredApprovals!: number;

  @ApiProperty({
    description: 'Proposal status',
    enum: ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'CANCELLED'],
    example: 'PENDING',
  })
  status!: string;

  @ApiPropertyOptional({ description: 'Moment the proposal expires', example: '2026-01-18T10:30:00.000Z' })
  expiresAt?: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

/** A decision a reviewer recorded against a proposal. */
export class ApprovalRecordDto {
  @ApiProperty({ description: 'Approval id', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Reviewer that recorded the decision', format: 'uuid' })
  userId!: string;

  @ApiProperty({ description: 'Recorded decision', enum: ['APPROVED', 'REJECTED', 'DELEGATED', 'EXPIRED'], example: 'APPROVED' })
  decision!: string;

  @ApiPropertyOptional({ description: 'Comment left by the reviewer' })
  comment?: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T11:00:00.000Z' })
  createdAt!: string;
}
