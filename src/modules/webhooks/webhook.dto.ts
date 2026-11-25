import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { cursorPaginationQuerySchema } from '../../common/pagination/cursor-pagination';
import { validateWebhookUrlSyntax } from './webhook-destination.policy';

/** Delivery states exposed by the list filter and the replay contract. */
export const webhookDeliveryStatuses = [
  'PENDING',
  'RETRYING',
  'DEAD_LETTER',
  'FAILED',
  'DELIVERED',
] as const;

/** `GET /webhooks/deliveries` query: cursor pagination plus an optional status filter. */
export const webhookDeliveryQuerySchema = cursorPaginationQuerySchema.extend({
  status: z.enum(webhookDeliveryStatuses).optional(),
});
export type WebhookDeliveryQuery = z.infer<typeof webhookDeliveryQuerySchema>;

const webhookUrlSchema = z.string().url().superRefine((url, context) => {
  try {
    validateWebhookUrlSyntax(url);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Webhook URL is not allowed',
    });
  }
});

export const createWebhookSchema = z
  .object({
    url: webhookUrlSchema,
    events: z.array(z.string().min(1).max(80)).min(1).max(50),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    events: z.array(z.string().min(1).max(80)).min(1).max(50).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

// ── Swagger DTOs ──

export class CreateWebhookDto {
  @ApiProperty({ example: 'https://example.com/hooks/astroid', description: 'Target URL the events are delivered to' })
  url!: string;

  @ApiProperty({
    type: [String],
    example: ['transaction.completed', 'proposal.approved'],
    description: 'Events the webhook subscribes to',
  })
  events!: string[];

  @ApiPropertyOptional({ example: true, description: 'Whether the webhook delivers events' })
  enabled?: boolean;
}

export class WebhookSecretDto {
  @ApiProperty({ description: 'HMAC signing secret. Returned on create/rotate only — never again.' })
  secret!: string;
}


/** A webhook subscription as returned by the API. */
export class WebhookResponseDto {
  @ApiProperty({ description: 'Webhook id', format: 'uuid', example: '018f0a1b-5555-4000-8000-000000000000' })
  id!: string;

  @ApiProperty({ description: 'Target URL of the webhook', example: 'https://partner.example.com/hooks/astroid' })
  url!: string;

  @ApiProperty({
    type: [String],
    description: 'Events the webhook is subscribed to',
    example: ['transaction.completed', 'proposal.approved'],
  })
  events!: string[];

  @ApiProperty({ description: 'Whether the webhook delivers events', example: true })
  enabled!: boolean;

  @ApiProperty({ description: 'Creation timestamp', example: '2026-01-15T10:30:00.000Z' })
  createdAt!: string;
}

export class WebhookDeliveryDto {
  @ApiProperty({ description: 'Delivery id', format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Webhook id', format: 'uuid' }) webhookId!: string;
  @ApiProperty({ description: 'Domain event delivered to the webhook.' }) eventName!: string;
  @ApiProperty({ enum: webhookDeliveryStatuses, description: 'Latest delivery state.' }) status!: string;
  @ApiProperty({ description: 'Number of delivery attempts.' }) attempts!: number;
  @ApiProperty({ description: 'Creation timestamp' }) createdAt!: string;
}

/** Result of manually replaying a dead-lettered delivery. */
export class WebhookDeliveryReplayDto {
  @ApiProperty({ description: 'Delivery id', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Webhook id', format: 'uuid' })
  webhookId!: string;

  @ApiProperty({ description: 'Domain event being replayed' })
  eventName!: string;

  @ApiProperty({ enum: ['PENDING'], description: 'Delivery state after the replay was enqueued' })
  status!: string;

  @ApiProperty({ description: 'True when a replay job was enqueued' })
  replayed!: boolean;
}
