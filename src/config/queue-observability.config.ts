import { registerAs } from '@nestjs/config';
import { queueEnvSchema, validateEnv } from './env.validation';

export type QueueObservabilityConfig = {
  enabled: boolean;
  maxFailedJobsPerQueue: number;
};

export const queueObservabilityConfig = registerAs('queueObservability', (): QueueObservabilityConfig => {
  const env = validateEnv(queueEnvSchema, process.env);
  return {
    enabled: env.QUEUE_OBSERVABILITY_ENABLED,
    maxFailedJobsPerQueue: env.QUEUE_OBSERVABILITY_MAX_FAILED_JOBS,
  };
});