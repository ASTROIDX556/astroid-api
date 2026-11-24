import { registerAs } from '@nestjs/config';
import { queueEnvSchema, validateEnv } from './env.validation';

export type QueueConfig = {
  prefix: string;
  concurrency: number;
  webhookDeliveryMaxAttempts: number;
  webhookRetryDelayMs: number;
  webhookHttpTimeoutMs: number;
  webhookFailedJobRetentionSeconds: number;
  webhookDeadLetterRetentionSeconds: number;
};

export const queueConfig = registerAs('queue', (): QueueConfig => {
  const queueEnv = validateEnv(queueEnvSchema, process.env);
  return {
    prefix: queueEnv.QUEUE_PREFIX,
    concurrency: queueEnv.QUEUE_CONCURRENCY,
    webhookDeliveryMaxAttempts: queueEnv.WEBHOOK_DELIVERY_MAX_ATTEMPTS,
    webhookRetryDelayMs: queueEnv.WEBHOOK_RETRY_DELAY_MS,
    webhookHttpTimeoutMs: queueEnv.WEBHOOK_HTTP_TIMEOUT_MS,
    webhookFailedJobRetentionSeconds: queueEnv.WEBHOOK_FAILED_JOB_RETENTION_SECONDS,
    webhookDeadLetterRetentionSeconds: queueEnv.WEBHOOK_DEAD_LETTER_RETENTION_SECONDS,
  };
});
