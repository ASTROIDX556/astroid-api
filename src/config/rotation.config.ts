import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { validateEnv } from './env.validation';

export type RotationConfig = {
  apiKeyRotationGracePeriodHours: number;
};

export const rotationEnvSchema = z.object({
  API_KEY_ROTATION_GRACE_PERIOD_HOURS: z
    .coerce.number()
    .int()
    .positive()
    .default(24),
});

export const rotationConfig = registerAs('rotation', (): RotationConfig => {
  const env = validateEnv(rotationEnvSchema, process.env);
  return {
    apiKeyRotationGracePeriodHours: env.API_KEY_ROTATION_GRACE_PERIOD_HOURS,
  };
});