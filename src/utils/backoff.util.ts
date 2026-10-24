/**
 * Exponential backoff utilities with randomized jitter.
 *
 * Jitter prevents "thundering herd" problems where many retrying clients
 * hit the same endpoint simultaneously. Each delay is calculated as:
 *
 *   delay = min(baseDelay * 2^(attempt - 1) + random(0, baseDelay * jitterFactor * attempt), maxDelay)
 *
 * With a 20% jitter factor and 2000ms base:
 * - Attempt 1: 2000ms + random(0, 400ms)
 * - Attempt 2: 4000ms + random(0, 800ms)
 * - Attempt 3: 8000ms + random(0, 1600ms)
 * - Attempt 4: 16000ms + random(0, 3200ms)
 *
 * Every delay is optionally capped by a maximum delay so a long-lived
 * integration can never schedule a retry hours away: the cap is applied to the
 * *total* delay (exponential part plus jitter).
 *
 * The attempt number is 1-based and matches the argument BullMQ hands to a
 * custom backoff strategy (`job.attemptsMade + 1`), so the delay of the first
 * retry is the base delay — exactly like BullMQ's built-in exponential
 * backoff.
 */

import type { BackoffStrategy } from 'bullmq';

/** Default jitter factor (20% of base delay). */
const DEFAULT_JITTER_FACTOR = 0.2;

/** Default base delay for webhook retries (2 seconds). */
const DEFAULT_BASE_DELAY_MS = 2_000;

/**
 * Calculates the deterministic exponential backoff delay for an attempt.
 *
 * This is the pure part of the backoff — the value before jitter is added —
 * and the value the maximum delay caps.
 *
 * @param attempt     - 1-based attempt number (1 = first retry)
 * @param baseDelay   - base delay in milliseconds (e.g. 2000)
 * @param maxDelayMs  - upper bound for the returned delay; omitted means unbounded
 * @returns delay in milliseconds (floored to integer)
 */
export function exponentialBackoffDelay(
  attempt: number,
  baseDelay: number = DEFAULT_BASE_DELAY_MS,
  maxDelayMs?: number,
): number {
  const exponentialDelay = Math.floor(baseDelay * Math.pow(2, attempt - 1));
  return maxDelayMs === undefined ? exponentialDelay : Math.min(exponentialDelay, maxDelayMs);
}

/**
 * Calculates exponential backoff delay with randomized jitter.
 *
 * @param attempt      - 1-based attempt number (1 = first retry)
 * @param baseDelay    - base delay in milliseconds (e.g. 2000)
 * @param jitterFactor - fraction of base delay to add as jitter (0–1, default 0.2)
 * @param maxDelayMs   - upper bound for the total delay; omitted means unbounded
 * @returns delay in milliseconds with jitter applied (floored to integer)
 */
export function exponentialBackoffWithJitter(
  attempt: number,
  baseDelay: number = DEFAULT_BASE_DELAY_MS,
  jitterFactor: number = DEFAULT_JITTER_FACTOR,
  maxDelayMs?: number,
): number {
  // The jitter is added on top of the uncapped exponential delay and the sum
  // is capped afterwards, so the maximum delay bounds the total wait.
  const exponentialDelay = exponentialBackoffDelay(attempt, baseDelay);
  const jitterRange = baseDelay * jitterFactor * attempt;
  const jitter = Math.random() * jitterRange;
  const total = Math.floor(exponentialDelay + jitter);
  return maxDelayMs === undefined ? total : Math.min(total, maxDelayMs);
}

/**
 * The jittered delay of the platform's backoff strategy.
 *
 * `attemptsMade` is the 1-based attempt number BullMQ passes to a custom
 * backoff strategy, so the first retry (attempt 1) waits exactly the base
 * delay — the same schedule BullMQ's built-in exponential backoff produces.
 *
 * This is the single formula behind `createJitteredBackoffStrategy`, exposed
 * separately so a caller can predict the delay the queue will schedule.
 */
export function jitteredBackoffDelay(
  attemptsMade: number,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
  maxDelayMs?: number,
): number {
  return exponentialBackoffWithJitter(attemptsMade, baseDelayMs, DEFAULT_JITTER_FACTOR, maxDelayMs);
}

/**
 * Custom BullMQ backoff strategy with jitter and an optional maximum delay.
 *
 * Compatible with BullMQ's `BackoffStrategy` type. It is only used when the
 * job options select the `custom` backoff type: BullMQ prefers its built-in
 * `fixed` and `exponential` strategies over a registered custom strategy, so
 * a queue that wants jitter or a delay cap must opt into `custom`.
 *
 * @see https://docs.bullmq.io/guide/retrying-failing-jobs#custom-backoff-strategy
 */
export const webhookBackoffStrategy: BackoffStrategy = (attemptsMade) => {
  return exponentialBackoffWithJitter(Math.max(attemptsMade, 1), DEFAULT_BASE_DELAY_MS, DEFAULT_JITTER_FACTOR);
};

/** Creates a webhook retry strategy using the configured base delay. */
export function createWebhookBackoffStrategy(baseDelayMs: number): BackoffStrategy {
  return (attemptsMade) =>
    exponentialBackoffWithJitter(Math.max(attemptsMade, 1), baseDelayMs, DEFAULT_JITTER_FACTOR);
}
