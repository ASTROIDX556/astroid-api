import type { JobsOptions } from 'bullmq';
import type { RegisterQueueOptions } from '@nestjs/bullmq';

import { queueConfig, type QueueConfig } from '../config/queue.config';
import { Queues } from './queues.constants';
import { buildJobOptions, createQueueRegistrationOptions } from './queue-policy';
import { WebhookConfig } from '../config/webhook.config';
import { jitteredBackoffDelay } from '../utils/backoff.util';
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
 * Builds the retry policy of the webhook queue from the resolved
 * configuration.
 *
 * The backoff uses the `custom` type on purpose: BullMQ prefers its built-in
 * `fixed` and `exponential` strategies over a registered custom strategy, so
 * only the `custom` type actually uses the jittered, capped strategy that
 * `createQueueRegistrationOptions` attaches to the queue.
 */
export function webhookJobOptionsFor(settings: WebhookConfig): JobsOptions {
  return buildJobOptions({
    attempts: settings.maxAttempts,
    backoff: {
      type: 'custom',
      delay: settings.backoffBaseDelayMs,
    },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { age: 24 * 3_600 },
  });
}

/**
 * The delay before the next attempt of a delivery that already made
 * `attemptsMade` failed attempts.
 *
 * BullMQ calls the backoff strategy with `attemptsMade + 1`, so the helper
 * mirrors exactly that call and therefore reports the very delay the queue
 * will schedule.
 * - A configured attempt limit bounds the work spent on a dead endpoint.
 * - Exponential backoff spaces retries out using a configured base delay.
 * - Configured failed-job retention keeps exhausted jobs inspectable
 *   long enough for an operator to act, without growing Redis forever.
 */
export function webhookRetryDelayMs(
  attemptsMade: number,
  settings: Pick<WebhookConfig, 'backoffBaseDelayMs' | 'backoffMaxDelayMs'>,
): number {
  return jitteredBackoffDelay(
    attemptsMade + 1,
    settings.backoffBaseDelayMs,
    settings.backoffMaxDelayMs,
  );
}

/**
 * Builds the BullMQ registration for the webhook queue.
 *
 * The custom `backoffStrategy` adds ±20% randomized jitter on top of the
 * exponential delay so a fleet of failing subscribers is not retried in
 * lockstep (thundering herd), and caps the result at the configured maximum
 * delay. BullMQ reads the strategy from
 * `queue.opts.settings.backoffStrategy` at retry time; `@nestjs/bullmq` does not
 * surface that field on `RegisterQueueOptions`, hence the narrow cast.
 */
export function createWebhookJobOptions(config: QueueConfig = queueConfig()): JobsOptions {
  return buildJobOptions({
    attempts: config.webhookDeliveryMaxAttempts,
    backoff: { type: 'exponential', delay: config.webhookRetryDelayMs },
    removeOnFail: { age: config.webhookFailedJobRetentionSeconds },
  });
}

export function createWebhookQueueOptions(settings: WebhookConfig): RegisterQueueOptions;
export function createWebhookQueueOptions(config?: QueueConfig): RegisterQueueOptions;
export function createWebhookQueueOptions(
  value: WebhookConfig | QueueConfig = queueConfig(),
): RegisterQueueOptions {
  if ('maxAttempts' in value) {
    return createQueueRegistrationOptions(
      Queues.Webhooks,
      webhookJobOptionsFor(value),
      value.backoffMaxDelayMs,
    );
  }

  const options = createQueueRegistrationOptions(Queues.Webhooks, createWebhookJobOptions(value));
  return {
    ...options,
    settings: {
      ...options.settings,
      backoffStrategy: createWebhookBackoffStrategy(value.webhookRetryDelayMs),
    } as RegisterQueueOptions['settings'],
  };
}

/** Backward-compatible default options used by older dispatch integrations. */
export const webhookJobOptions: JobsOptions = createWebhookJobOptions();
