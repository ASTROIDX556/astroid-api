import { registerAs } from '@nestjs/config';
import { databaseEnvSchema, validateEnv } from './env.validation';

export type DatabaseConfig = {
  url: string;
  slowQueryThresholdMs: number;
  enableSlowQueryLogging: boolean;
};

export const databaseConfig = registerAs('database', (): DatabaseConfig => {
  const env = validateEnv(databaseEnvSchema, process.env);
  return {
    url: env.DATABASE_URL,
    slowQueryThresholdMs: env.SLOW_QUERY_THRESHOLD_MS,
    enableSlowQueryLogging: env.ENABLE_SLOW_QUERY_LOGGING,
  };
});
