import type { JobsOptions } from 'bullmq';
import type { RegisterQueueOptions } from '@nestjs/bullmq';

import { queueConfig, type QueueConfig } from '../config/queue.config';
import { Queues } from './queues.constants';
import { buildJobOptions, createQueueRegistrationOptions } from './queue-policy';
import { createWebhookBackoffStrategy } from '../utils/backoff.util';

/** BullMQ job name used for every outbound webhook delivery. */
export const WEBHOOK_JOB_NAME = 'webhook-delivery';

/** Default total delivery attempts (1 initial + 4 retries). */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/** Default base delay in milliseconds for exponential backoff. */
export const WEBHOOK_BACKOFF_BASE_DELAY_MS = 2_000;
/** Default HTTP request timeout in milliseconds. */
export const WEBHOOK_HTTP_TIMEOUT_MS = 5_000;
/** Default retention for exhausted webhook jobs, in seconds. */
export const WEBHOOK_FAILED_JOB_RETENTION_SECONDS = 24 * 3_600;

/** Queue that permanently failed webhook deliveries are routed to for inspection. */
export const WEBHOOK_DEAD_LETTER_QUEUE = Queues.DeadLetter;

/**
 * Retry policy applied to every queued webhook delivery.
 *
 * - A configured attempt limit bounds the work spent on a dead endpoint.
 * - Exponential backoff spaces retries out using a configured base delay.
 * - Configured failed-job retention keeps exhausted jobs inspectable
 *   long enough for an operator to act, without growing Redis forever.
 */
export const webhookJobOptions: JobsOptions = buildJobOptions({
  attempts: WEBHOOK_MAX_ATTEMPTS,
  backoff: {
    type: 'exponential',
    delay: WEBHOOK_BACKOFF_BASE_DELAY_MS,
  },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
});

/**
 * Builds the BullMQ registration for the webhook queue.
 */
export function createWebhookJobOptions(config: QueueConfig = queueConfig()): JobsOptions {
  return buildJobOptions({
    attempts: config.webhookDeliveryMaxAttempts,
    backoff: { type: 'exponential', delay: config.webhookRetryDelayMs },
    removeOnFail: { age: config.webhookFailedJobRetentionSeconds },
  });
}

export function createWebhookQueueOptions(config: QueueConfig = queueConfig()): RegisterQueueOptions {
  const options = createQueueRegistrationOptions(Queues.Webhooks, createWebhookJobOptions(config));
  return {
    ...options,
    settings: {
      ...options.settings,
      backoffStrategy: createWebhookBackoffStrategy(config.webhookRetryDelayMs),
    } as RegisterQueueOptions['settings'],
  };
}
