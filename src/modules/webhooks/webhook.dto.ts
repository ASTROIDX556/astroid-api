import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WebhookDeliveryStatus } from '@prisma/client';
import { paginationQuerySchema } from '../../common/pagination';

export const createWebhookSchema = z
  .object({
    url: z.string().url(),
    events: z.array(z.string().min(1).max(80)).min(1).max(50),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z
  .object({
    url: z.string().url().optional(),
    events: z.array(z.string().min(1).max(80)).min(1).max(50).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

/** Delivery log filters (#550). `status=FAILED_PERMANENTLY` lists the DLQ. */
export const listDeliveriesSchema = paginationQuerySchema.extend({
  webhookId: z.string().min(1).max(64).optional(),
  status: z.nativeEnum(WebhookDeliveryStatus).optional(),
});
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesSchema>;

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
