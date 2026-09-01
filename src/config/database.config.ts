import { registerAs } from '@nestjs/config';
import { databaseEnvSchema, validateEnv } from './env.validation';

/**
 * Database connection configuration.
 *
 * `url` is the raw connection string. The pool sizing and timeout fields drive
 * the Prisma client setup in `PrismaService` (see `buildDatasourceUrl`):
 *   - `connectionLimit`   → Prisma `connection_limit` URL param (pool size)
 *   - `poolTimeoutMs`     → Prisma `pool_timeout` URL param (wait-for-connection)
 *   - `statementTimeoutMs`→ server-side `statement_timeout` via `options` param
 *   - `queryTimeoutMs`    → client-side race guard applied via a Prisma extension
 *
 * The `worker*` fields configure a dedicated, smaller pool for background
 * workers. It carries no server-side `statement_timeout` and a much longer
 * client-side guard so long-running worker transactions are never aborted by
 * the API-oriented timeouts.
 */
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
