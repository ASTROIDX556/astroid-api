import { registerAs } from '@nestjs/config';
import { authEnvSchema, validateEnv } from './env.validation';

export type AuthConfig = {
  accessSecret: string;
  refreshSecret: string;
  accessTtl: number;
  refreshTtl: number;
  apiKeyRotationGracePeriodSeconds: number;
  passkey: {
    rpId: string;
    rpName: string;
    origin: string;
  };
};

export const authConfig = registerAs('auth', (): AuthConfig => {
  const env = validateEnv(authEnvSchema, process.env);
  return {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    apiKeyRotationGracePeriodSeconds: env.API_KEY_ROTATION_GRACE_PERIOD_SECONDS,
    passkey: {
      rpId: env.PASSKEY_RP_ID,
      rpName: env.PASSKEY_RP_NAME,
      origin: env.PASSKEY_ORIGIN,
    },
  };
});
