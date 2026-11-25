/**
 * Retry-After header parsing utilities.
 *
 * The Retry-After header can be either:
 * - A non-negative integer representing seconds to wait (e.g., "120")
 * - An HTTP-date timestamp (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
 *
 * This module provides safe parsing that handles clock drift and invalid values.
 */

import { Logger } from '@nestjs/common';

const logger = new Logger('RetryAfterUtil');

/** Maximum allowed Retry-After value in seconds (1 hour). */
export const MAX_RETRY_AFTER_SECONDS = 3_600;

/** Default Retry-After value in seconds when header is missing or invalid. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Parses a Retry-After header value into a delay in milliseconds.
 *
 * @param headerValue - The raw Retry-After header value
 * @param maxDelayMs - Optional maximum delay cap in milliseconds
 * @returns Delay in milliseconds, or null if header is invalid/missing
 */
export function parseRetryAfter(headerValue: string | string[] | undefined, maxDelayMs?: number): number | null {
  if (!headerValue) {
    return null;
  }

  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // Try parsing as seconds (non-negative integer)
  const seconds = Number(trimmed);
  if (Number.isInteger(seconds) && seconds >= 0) {
    const delayMs = Math.min(seconds * 1_000, maxDelayMs ?? MAX_RETRY_AFTER_SECONDS * 1_000);
    if (delayMs > MAX_RETRY_AFTER_SECONDS * 1_000) {
      logger.warn(`Retry-After value ${seconds}s exceeds maximum of ${MAX_RETRY_AFTER_SECONDS}s; capped`);
    }
    return delayMs;
  }

  // Try parsing as HTTP-date
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    const now = Date.now();
    const delayMs = date.getTime() - now;

    // If the date is in the past or more than maxDelayMs in the future, treat as invalid
    if (delayMs <= 0) {
      logger.warn('Retry-After date is in the past; ignoring');
      return null;
    }
    if (maxDelayMs && delayMs > maxDelayMs) {
      logger.warn(`Retry-After date exceeds maximum delay of ${maxDelayMs}ms; capped`);
      return maxDelayMs;
    }
    return delayMs;
  }

  // Invalid format
  logger.warn(`Unable to parse Retry-After header: ${trimmed}`);
  return null;
}

/**
 * Calculates the effective retry delay for a webhook delivery attempt.
 *
 * Uses Retry-After header when available and valid, otherwise falls back to
 * the standard exponential backoff with jitter.
 *
 * @param retryAfterHeader - The Retry-After header value from the response
 * @param attemptsMade - Number of attempts already made (0-based)
 * @param baseDelayMs - Base delay for exponential backoff
 * @param maxDelayMs - Maximum delay cap
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(
  retryAfterHeader: string | string[] | undefined,
  attemptsMade: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const retryAfterDelay = parseRetryAfter(retryAfterHeader, maxDelayMs);

  if (retryAfterDelay !== null) {
    return retryAfterDelay;
  }

  // Fall back to exponential backoff with jitter
  const attempt = attemptsMade + 1;
  const exponentialDelay = Math.floor(baseDelayMs * Math.pow(2, attempt - 1));
  const jitterRange = baseDelayMs * 0.2 * attempt;
  const jitter = Math.random() * jitterRange;
  const total = Math.floor(exponentialDelay + jitter);
  return Math.min(total, maxDelayMs);
}