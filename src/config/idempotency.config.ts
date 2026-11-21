import { registerAs } from '@nestjs/config';
import { idempotencyEnvSchema, validateEnv } from './env.validation';

export type IdempotencyConfig = {
  /** Retention window for completed idempotency records, in milliseconds. */
  keyTtlMs: number;
  /** How long a duplicate request waits for an in-flight original, in milliseconds. */
  waitTimeoutMs: number;
  /** Poll interval used while waiting for the in-flight original, in milliseconds. */
  pollIntervalMs: number;
};

export const idempotencyConfig = registerAs('idempotency', (): IdempotencyConfig => {
  const env = validateEnv(idempotencyEnvSchema, process.env);
  return {
    keyTtlMs: env.IDEMPOTENCY_KEY_TTL_HOURS * 60 * 60 * 1000,
    waitTimeoutMs: env.IDEMPOTENCY_WAIT_TIMEOUT_MS,
    pollIntervalMs: env.IDEMPOTENCY_POLL_INTERVAL_MS,
  };
});
