import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { validateWebhookUrlSyntax } from './webhook-destination.policy';

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
