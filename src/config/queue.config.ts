import { registerAs } from '@nestjs/config';
import { queueEnvSchema, throttleEnvSchema, validateEnv } from './env.validation';

export type QueueConfig = {
  prefix: string;
  concurrency: number;
  throttle: {
    authLimit: number;
    apiLimit: number;
    webhookLimit: number;
    ttl: number;
    /** Burst: max requests per second before the burst limiter kicks in. */
    apiBurst: number;
    authBurst: number;
    webhookBurst: number;
  };
};

export const queueConfig = registerAs('queue', (): QueueConfig => {
  const queueEnv = validateEnv(queueEnvSchema, process.env);
  const throttleEnv = validateEnv(throttleEnvSchema, process.env);
  return {
    prefix: queueEnv.QUEUE_PREFIX,
    concurrency: queueEnv.QUEUE_CONCURRENCY,
    throttle: {
      authLimit: throttleEnv.THROTTLE_AUTH_LIMIT,
      apiLimit: throttleEnv.THROTTLE_API_LIMIT,
      webhookLimit: throttleEnv.THROTTLE_WEBHOOK_LIMIT,
      ttl: throttleEnv.THROTTLE_TTL,
      apiBurst: throttleEnv.THROTTLE_API_BURST,
      authBurst: throttleEnv.THROTTLE_AUTH_BURST,
      webhookBurst: throttleEnv.THROTTLE_WEBHOOK_BURST,
    },
  };
});
