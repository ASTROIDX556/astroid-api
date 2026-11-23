import { registerAs } from '@nestjs/config';
import { validateEnv, webhookEnvSchema } from './env.validation';

/**
 * Webhook delivery retry settings (#550). Retry delays are a capped schedule:
 * by default 30s, 1m, 5m, 15m, 30m, with +/- 20% jitter to avoid synchronised
 * retry storms. Maximum 6 attempts in total (initial try + 5 retries).
 */
export interface WebhookRetrySettings {
  maxAttempts: number;
  timeoutMs: number;
  jitterRatio: number;
  delaysMs: readonly number[];
}

export type WebhookConfig = WebhookRetrySettings;

export const WEBHOOK_BACKOFF_TYPE = 'astroid-webhook-backoff';

/** Parses the comma-separated delay schedule, dropping invalid entries. */
export function parseWebhookDelays(raw: string): number[] {
  const delays = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return delays.length > 0 ? delays : [30_000, 60_000, 300_000, 900_000, 1_800_000];
}

/**
 * Resolves retry settings from the environment. Used both by Nest (through the
 * `webhook` config slice) and by the BullMQ backoff strategy, which must be a
 * plain function.
 */
export function loadWebhookRetrySettings(
  env: NodeJS.ProcessEnv = process.env,
): WebhookRetrySettings {
  const parsed = validateEnv(webhookEnvSchema, env);
  return {
    maxAttempts: parsed.WEBHOOK_MAX_ATTEMPTS,
    timeoutMs: parsed.WEBHOOK_TIMEOUT_MS,
    jitterRatio: parsed.WEBHOOK_BACKOFF_JITTER_RATIO,
    delaysMs: parseWebhookDelays(parsed.WEBHOOK_BACKOFF_DELAYS_MS),
  };
}

export const webhookConfig = registerAs('webhook', (): WebhookConfig =>
  loadWebhookRetrySettings(),
);
