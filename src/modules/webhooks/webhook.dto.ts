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
  @ApiProperty({ example: 'https://example.com/hooks/astroid' })
  url!: string;

  @ApiProperty({ type: [String], example: ['transaction.completed', 'proposal.approved'] })
  events!: string[];

  @ApiPropertyOptional()
  enabled?: boolean;
}

export class WebhookSecretDto {
  @ApiProperty({ description: 'HMAC signing secret. Returned on create/rotate only — never again.' })
  secret!: string;
}
