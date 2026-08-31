import { registerAs } from '@nestjs/config';
import { metricsEnvSchema, validateEnv } from './env.validation';

export type MetricsConfig = {
  /** CIDR ranges permitted to scrape /metrics. Empty list allows any source. */
  allowedIps: string[];
};

export const metricsConfig = registerAs('metrics', (): MetricsConfig => {
  const env = validateEnv(metricsEnvSchema, process.env);
  return {
    allowedIps: env.METRICS_ALLOWED_IPS.split(',')
      .map((cidr) => cidr.trim())
      .filter((cidr) => cidr.length > 0),
  };
});
