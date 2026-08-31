/**
 * Exponential backoff utilities with randomized jitter.
 *
 * Jitter prevents "thundering herd" problems where many retrying clients
 * hit the same endpoint simultaneously. Each delay is calculated as:
 *
 *   delay = baseDelay * 2^(attempt - 1) + random(0, baseDelay * jitterFactor * attempt)
 *
 * With a 20% jitter factor and 2000ms base:
 * - Attempt 1: 2000ms + random(0, 400ms)
 * - Attempt 2: 4000ms + random(0, 800ms)
 * - Attempt 3: 8000ms + random(0, 1600ms)
 * - Attempt 4: 16000ms + random(0, 3200ms)
 */

import type { BackoffStrategy } from 'bullmq';

/** Default jitter factor (20% of base delay). */
const DEFAULT_JITTER_FACTOR = 0.2;

/** Default base delay for webhook retries (2 seconds). */
const DEFAULT_BASE_DELAY_MS = 2_000;

/**
 * Calculates exponential backoff delay with randomized jitter.
 *
 * @param attempt      - 1-based attempt number (1 = first retry)
 * @param baseDelay    - base delay in milliseconds (e.g. 2000)
 * @param jitterFactor - fraction of base delay to add as jitter (0–1, default 0.2)
 * @returns delay in milliseconds with jitter applied (floored to integer)
 */
export function exponentialBackoffWithJitter(
  attempt: number,
  baseDelay: number = DEFAULT_BASE_DELAY_MS,
  jitterFactor: number = DEFAULT_JITTER_FACTOR,
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
  const jitterRange = baseDelay * jitterFactor * attempt;
  const jitter = Math.random() * jitterRange;
  return Math.floor(exponentialDelay + jitter);
}

/**
 * Custom BullMQ backoff strategy for webhook delivery with jitter.
 *
 * Compatible with BullMQ's `BackoffStrategy` type. Registered on the
 * Worker via the `backoffStrategy` option so it overrides the default
 * exponential calculation with jittered delays.
 *
 * @see https://docs.bullmq.io/guide/retrying-failing-jobs#custom-backoff-strategy
 */
export const webhookBackoffStrategy: BackoffStrategy = (attemptsMade) => {
  return exponentialBackoffWithJitter(attemptsMade + 1, DEFAULT_BASE_DELAY_MS, DEFAULT_JITTER_FACTOR);
};
