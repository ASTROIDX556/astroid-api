/**
 * BullMQ job types for webhook delivery with retry logic.
 */

export interface WebhookJobData {
  webhookId: string;
  organizationId: string;
  url: string;
  secret: string;
  eventName: string;
  payload: unknown;
  eventId: string;
}

export interface WebhookJobResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}
