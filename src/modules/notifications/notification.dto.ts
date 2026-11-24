import { z } from 'zod';
import { ApiProperty } from '@nestjs/swagger';

export const markReadSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict();
export type MarkReadInput = z.infer<typeof markReadSchema>;

export class MarkReadDto {
  @ApiProperty({ type: [String], description: 'Notification ids to mark as read' })
  ids!: string[];
}

/** A notification delivered to a member of the organization. */
export class NotificationResponseDto {
  @ApiProperty({ description: 'Notification id', format: 'uuid', example: '018f0a1b-2222-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Notification title', example: 'Approval required' })
  title!: string;

  @ApiProperty({ description: 'Notification body', example: 'A transaction is awaiting your approval.' })
  body!: string;

  @ApiProperty({
    description: 'Kind of notification',
    enum: ['BUDGET_EXCEEDED', 'PROPOSAL_APPROVED', 'PROPOSAL_REJECTED', 'WALLET_FUNDED', 'PAYMENT_FAILED', 'POLICY_VIOLATION', 'RISK_ALERT', 'APPROVAL_REQUIRED', 'INFO'],
    example: 'APPROVAL_REQUIRED',
  })
  type!: string;

  @ApiProperty({ description: 'Delivery channel', enum: ['DASHBOARD', 'EMAIL', 'DISCORD', 'SLACK', 'WEBHOOK'], example: 'DASHBOARD' })
  channel!: string;

  @ApiProperty({ description: 'Whether the notification was already read', example: false })
  read!: boolean;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

/** The number of unread notifications. */
export class UnreadCountDto {
  @ApiProperty({ description: 'Number of unread notifications', example: 3 })
  unread!: number;
}

/** The number of notifications that were marked as read. */
export class MarkedReadDto {
  @ApiProperty({ description: 'Number of notifications that were updated', example: 3 })
  updated!: number;
}
