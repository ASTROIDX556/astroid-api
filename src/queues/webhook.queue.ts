import type { JobsOptions } from 'bullmq';
import type { RegisterQueueOptions } from '@nestjs/bullmq';

import { Queues } from './queues.constants';
import { buildJobOptions, createQueueRegistrationOptions } from './queue-policy';
import { WebhookConfig } from '../config/webhook.config';
import { jitteredBackoffDelay } from '../utils/backoff.util';

/** BullMQ job name used for every outbound webhook delivery. */
export const WEBHOOK_JOB_NAME = 'webhook-delivery';

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
export function createWebhookQueueOptions(settings: WebhookConfig): RegisterQueueOptions {
  return createQueueRegistrationOptions(
    Queues.Webhooks,
    webhookJobOptionsFor(settings),
    settings.backoffMaxDelayMs,
  );
}
