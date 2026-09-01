import { z } from 'zod';

/**
 * Base Zod schemas for every configuration slice. Each config factory validates
 * `process.env` on startup and throws a descriptive error if invalid — the app
 * must never boot with an invalid configuration.
 */

export const appEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('astroid-api'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('api/v1'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CORS_ORIGINS: z.string().default('*'),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().nonnegative().default(250),
  ENABLE_SLOW_QUERY_LOGGING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export const redisEnvSchema = z.object({
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
});

export const authEnvSchema = z.object({
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be >= 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be >= 16 chars'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(1209600),
  PASSKEY_RP_ID: z.string().default('localhost'),
  PASSKEY_RP_NAME: z.string().default('Astroid'),
  PASSKEY_ORIGIN: z.string().default('http://localhost:3001'),
});

export const stellarEnvSchema = z.object({
  STELLAR_NETWORK: z.enum(['testnet', 'public', 'futurenet']).default('testnet'),
  STELLAR_HORIZON_URL: z.string().default('https://horizon-testnet.stellar.org'),
  STELLAR_SOROBAN_RPC_URL: z.string().default('https://soroban-testnet.stellar.org'),
  STELLAR_REGISTRY_CONTRACT_ID: z.string().optional().default(''),
  STELLAR_USE_MOCK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export const storageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.string().default('http://localhost:9000'),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().default('astroid'),
  STORAGE_ACCESS_KEY: z.string().default('astroid'),
  STORAGE_SECRET_KEY: z.string().default('astroid-secret'),
});

export const queueEnvSchema = z.object({
  QUEUE_PREFIX: z.string().default('astroid'),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),
});

export const throttleEnvSchema = z.object({
  THROTTLE_AUTH_LIMIT: z.coerce.number().int().positive().default(10),
  THROTTLE_API_LIMIT: z.coerce.number().int().positive().default(120),
  THROTTLE_TTL: z.coerce.number().int().positive().default(60),
});

export const rateLimitEnvSchema = z.object({
  // Sliding-window size, in seconds, for the Redis-backed rate limiter guard.
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // Max requests allowed per client within the sliding window.
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
});

export const metricsEnvSchema = z.object({
  // Comma-separated CIDR ranges permitted to scrape /metrics. Defaults to
  // loopback + RFC1918 private ranges so the endpoint is internal-only unless
  // explicitly opened up (e.g. for a Prometheus server outside the VPC).
  METRICS_ALLOWED_IPS: z
    .string()
    .default('127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'),
});

export const aiEnvSchema = z.object({
  AI_PROVIDER: z.string().default('nvidia'),
  AI_PROVIDER_KEY: z.string().min(1, 'AI_PROVIDER_KEY is required'),
  AI_BASE_URL: z.string().default('https://integrate.api.nvidia.com/v1'),
  AI_MODEL: z.string().default('meta/llama-3.1-70b-instruct'),
});

export const encryptionEnvSchema = z.object({
  ENCRYPTION_KEY: z
    .string()
    .default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
    .refine(
      (key) => {
        if (!key) return false;
        if (/^[0-9a-fA-F]{64}$/.test(key)) return true;
        if (Buffer.byteLength(key, 'utf8') === 32) return true;
        try {
          const buf = Buffer.from(key, 'base64');
          if (buf.length === 32) return true;
        } catch {
          return false;
        }
        return false;
      },
      { message: 'ENCRYPTION_KEY must be a 32-byte (256-bit) key (64 hex characters or 32 bytes)' },
    ),
  ENCRYPTION_ALGORITHM: z.string().default('aes-256-gcm'),
});

/**
 * Validates a slice of the environment against a schema, throwing a readable
 * error that lists every failing variable. Returns the schema's OUTPUT type
 * (defaults applied, transforms resolved).
 */
export function validateEnv<T extends z.ZodTypeAny>(
  schema: T,
  env: NodeJS.ProcessEnv,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
