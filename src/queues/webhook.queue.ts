import type { JobsOptions } from 'bullmq';
import type { RegisterQueueOptions } from '@nestjs/bullmq';

import { Queues } from './queues.constants';
import { buildJobOptions, createQueueRegistrationOptions } from './queue-policy';
import { queueConfig } from '../config/queue.config';

/** BullMQ job name used for every outbound webhook delivery. */
export const WEBHOOK_JOB_NAME = 'webhook-delivery';

/** Total delivery attempts before a webhook is dead-lettered (default 5). */
export const WEBHOOK_MAX_ATTEMPTS = queueConfig().webhookMaxAttempts;

/** Base delay in milliseconds for the exponential backoff between attempts. */
export const WEBHOOK_BACKOFF_BASE_DELAY_MS = 2_000;

/** Queue that permanently failed webhook deliveries are routed to for inspection. */
export const WEBHOOK_DEAD_LETTER_QUEUE = Queues.DeadLetter;

/**
 * Retry policy applied to every queued webhook delivery.
 *
 * - `attempts` bounds the work spent on a dead endpoint (default 5).
 * - `backoff: exponential @ 2000ms` spaces retries out (2s, 4s, 8s, 16s).
 * - `removeOnFail.age: 24h` keeps exhausted jobs inspectable (and re-drivable)
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
 *
 * The custom `backoffStrategy` adds ±20% randomized jitter on top of the
 * exponential delay so a fleet of failing subscribers is not retried in
 * lockstep (thundering herd). BullMQ reads the strategy from
 * `queue.opts.settings.backoffStrategy` at retry time; `@nestjs/bullmq` does not
 * surface that field on `RegisterQueueOptions`, hence the narrow cast.
 */
export function createWebhookQueueOptions(): RegisterQueueOptions {
  return createQueueRegistrationOptions(Queues.Webhooks, webhookJobOptions);
}
