import { Injectable } from '@nestjs/common';
import {
  WebhookRetrySettings,
  loadWebhookRetrySettings,
} from '../../config/webhook.config';

/**
 * Decides whether a webhook delivery should be retried and how long to wait.
 * Pure and synchronous so it can be unit tested and reused by both the BullMQ
 * backoff strategy and the worker's persisted attempt tracking (#550).
 */
@Injectable()
export class WebhookRetryPolicy {
  constructor(private readonly settings: WebhookRetrySettings) {}

  get maxAttempts(): number {
    return this.settings.maxAttempts;
  }

  get timeoutMs(): number {
    return this.settings.timeoutMs;
  }

  /** The number of retries available after the first attempt. */
  get maxRetries(): number {
    return Math.max(0, this.settings.maxAttempts - 1);
  }

  /**
   * Retry on network errors/timeouts, 408, 429 and any 5xx. Every other 4xx
   * (400, 401, 403, 404, 422, …) is a permanent failure — the consumer rejected
   * the payload and will keep rejecting it.
   */
  isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  /** True when another attempt is allowed after `attempt` (1-based) failed. */
  hasAttemptsRemaining(attempt: number): boolean {
    return attempt < this.settings.maxAttempts;
  }

  /**
   * Backoff for a failed attempt, using the capped schedule with symmetric
   * jitter. `attempt` is 1-based (attempt 1 failing schedules the first retry).
   */
  computeDelayMs(attempt: number, random: number = Math.random()): number {
    const { delaysMs, jitterRatio } = this.settings;
    const index = Math.min(Math.max(attempt, 1) - 1, delaysMs.length - 1);
    const base = delaysMs[index] ?? 0;
    const sample = Math.min(1, Math.max(0, random));
    const jitter = base * jitterRatio * (sample * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }
}

/**
 * BullMQ custom backoff strategy. Registered on the webhook Worker so jobs
 * configured with `backoff: { type: WEBHOOK_BACKOFF_TYPE }` follow the capped,
 * jittered schedule instead of BullMQ's unbounded exponential default.
 */
export function webhookBackoffStrategy(attemptsMade: number): number {
  return new WebhookRetryPolicy(loadWebhookRetrySettings()).computeDelayMs(attemptsMade);
}
