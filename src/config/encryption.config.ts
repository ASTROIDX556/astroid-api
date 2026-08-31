import { registerAs } from '@nestjs/config';
import { encryptionEnvSchema, validateEnv } from './env.validation';

export type EncryptionConfig = {
  key: string;
  algorithm: string;
};

export const encryptionConfig = registerAs('encryption', (): EncryptionConfig => {
  const env = validateEnv(encryptionEnvSchema, process.env);
  return {
    key: env.ENCRYPTION_KEY,
    algorithm: env.ENCRYPTION_ALGORITHM,
  };
});
