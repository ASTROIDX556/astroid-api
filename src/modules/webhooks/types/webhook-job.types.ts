/**
 * BullMQ job types for webhook delivery with retry logic.
 */

import { QueueJobMetadata } from '../../../queues/queues.constants';

export interface WebhookJobData {
  webhookId: string;
  organizationId: string;
  url: string;
  eventName: string;
  payload: unknown;
  eventId: string;
  metadata?: QueueJobMetadata;
}

export interface WebhookJobResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/** Group key for BullMQ rate limiter: limits concurrent deliveries per webhook endpoint. */
export const WEBHOOK_CONCURRENCY_GROUP_PREFIX = 'webhook-endpoint:';

/** Builds the group key for a webhook endpoint. */
export function buildWebhookConcurrencyGroup(webhookId: string): string {
  return `${WEBHOOK_CONCURRENCY_GROUP_PREFIX}${webhookId}`;
}
