import { describe, expect, it } from 'vitest';
import { WebhookRetryPolicy } from './webhook-retry.policy';

const settings = {
  maxAttempts: 4,
  timeoutMs: 5_000,
  jitterRatio: 0.2,
  delaysMs: [30_000, 60_000, 300_000] as const,
};

describe('WebhookRetryPolicy', () => {
  const policy = new WebhookRetryPolicy(settings);

  it('retries network failures, 408, 429 and 5xx', () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(policy.isRetryableStatus(status)).toBe(true);
    }
  });

  it('does not retry other 4xx responses', () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(policy.isRetryableStatus(status)).toBe(false);
    }
  });

  it('stops once the maximum attempt count is reached', () => {
    expect(policy.hasAttemptsRemaining(1)).toBe(true);
    expect(policy.hasAttemptsRemaining(3)).toBe(true);
    expect(policy.hasAttemptsRemaining(4)).toBe(false);
    expect(policy.hasAttemptsRemaining(5)).toBe(false);
  });

  it('follows the configured schedule and caps at the last step', () => {
    expect(policy.computeDelayMs(1, 0.5)).toBe(30_000);
    expect(policy.computeDelayMs(2, 0.5)).toBe(60_000);
    expect(policy.computeDelayMs(3, 0.5)).toBe(300_000);
    expect(policy.computeDelayMs(4, 0.5)).toBe(300_000);
    expect(policy.computeDelayMs(50, 0.5)).toBe(300_000);
  });

  it('applies jitter within +/- the configured ratio and never goes negative', () => {
    expect(policy.computeDelayMs(1, 0)).toBe(24_000);
    expect(policy.computeDelayMs(1, 1)).toBe(36_000);
    expect(policy.computeDelayMs(1, -10)).toBe(24_000);
    expect(policy.computeDelayMs(1, 10)).toBe(36_000);
  });

  it('exposes maxRetries as attempts minus the initial try', () => {
    expect(policy.maxRetries).toBe(3);
    expect(new WebhookRetryPolicy({ ...settings, maxAttempts: 1 }).maxRetries).toBe(0);
  });
});
