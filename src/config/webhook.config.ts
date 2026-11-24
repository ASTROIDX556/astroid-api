import { registerAs } from '@nestjs/config';
import { validateEnv, webhookEnvSchema } from './env.validation';

/**
 * Outbound webhook delivery configuration.
 *
 * The retry policy is applied by the BullMQ queue registration (attempt count,
 * exponential backoff base and its maximum delay) and the circuit breaker
 * protects a single endpoint from being hammered while it is down.
 */
export type WebhookConfig = {
  /** Total delivery attempts (1 initial + retries) before a webhook is dead-lettered. */
  maxAttempts: number;
  /** Base delay in milliseconds for the exponential backoff between attempts. */
  backoffBaseDelayMs: number;
  /** Upper bound for a single backoff delay (ms). */
  backoffMaxDelayMs: number;
  /** Timeout of a single delivery request (ms). */
  requestTimeoutMs: number;
  /** Whether the per-endpoint circuit breaker is active. */
  circuitEnabled: boolean;
  /** Consecutive failed attempts against one endpoint before the circuit opens. */
  circuitFailureThreshold: number;
  /** How long the circuit stays open before a probe delivery is allowed (ms). */
  circuitCooldownMs: number;
};

/**
 * The documented defaults of the webhook delivery configuration. They mirror
 * the defaults of `webhookEnvSchema` and are used whenever the configuration
 * is not available (for example in a unit test).
 */
export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = {
  maxAttempts: 5,
  backoffBaseDelayMs: 2_000,
  backoffMaxDelayMs: 60_000,
  requestTimeoutMs: 5_000,
  circuitEnabled: true,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 300_000,
};

export const webhookConfig = registerAs('webhook', (): WebhookConfig => {
  const env = validateEnv(webhookEnvSchema, process.env);
  return {
    maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
    backoffBaseDelayMs: env.WEBHOOK_BACKOFF_BASE_DELAY_MS,
    backoffMaxDelayMs: env.WEBHOOK_BACKOFF_MAX_DELAY_MS,
    requestTimeoutMs: env.WEBHOOK_REQUEST_TIMEOUT_MS,
    circuitEnabled: env.WEBHOOK_CIRCUIT_ENABLED,
    circuitFailureThreshold: env.WEBHOOK_CIRCUIT_FAILURE_THRESHOLD,
    circuitCooldownMs: env.WEBHOOK_CIRCUIT_COOLDOWN_MS,
  };
});
