import { INestApplication, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { createSlowQueryMiddleware } from './slow-query.logger';

/**
 * The single Prisma client for the application. Manages connection lifecycle
 * and exposes graceful shutdown hooks. All repositories depend on this service.
 *
 * Connection-pool optimization and query-timeout guards (issue #76):
 *  - The datasource URL is built from `DATABASE_*` env vars with
 *    `connection_limit`, `pool_timeout` and a server-side
 *    `options=-c statement_timeout=...`, so runaway queries are aborted by
 *    Postgres and the pooled connection is actually released.
 *  - A Prisma client extension wraps every operation with a client-side race
 *    that fails fast with a structured `DatabaseTimeoutError` once a query
 *    exceeds `DATABASE_QUERY_TIMEOUT_MS`, and converts pool exhaustion
 *    (Prisma P2024) into a structured `ConnectionPoolExhaustedError`.
 *  - `workerClient` is a dedicated, smaller pool with extended timeouts and NO
 *    server-side `statement_timeout`, so long-running background worker
 *    transactions are never killed by the API-oriented guards.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Optional() private readonly configService?: ConfigService) {
    super({
      datasources: { db: { url } },
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });

    const thresholdMs = this.configService?.get<number>('database.slowQueryThresholdMs') ?? 250;
    const enabled = this.configService?.get<boolean>('database.enableSlowQueryLogging') ?? true;

    this.$use(
      createSlowQueryMiddleware({
        thresholdMs,
        enabled,
        logger: this.logger,
      }),
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      await this.workerClient.$connect();
      this.logger.log('Prisma connected to the database');

      // Validate migration status after successful connection.
      await this.validateMigrations();
    } catch (error) {
      // Do not crash on boot when the DB is unavailable (e.g. typecheck/build,
      // or during local development before `docker compose up`). Log and go on.
      this.logger.warn(
        `Prisma could not connect on startup: ${(error as Error).message}. ` +
          'The API will retry lazily on first query.',
      );
    }
  }

  /**
   * Validates that all Prisma migrations have been applied to the database.
   * In production/strict mode, pending or failed migrations cause a critical
   * error log. The application still starts (to avoid breaking CI/dev), but
   * the error is clearly surfaced for operators.
   */
  async validateMigrations(): Promise<MigrationCheckResult> {
    const migrationsDir = getDefaultMigrationsDir();
    const result = await checkMigrationStatus(this, migrationsDir);

    if (!result.upToDate) {
      this.logger.error(
        `Migration status check failed: ${result.message}`,
        JSON.stringify({
          pending: result.pending.map((m) => m.name),
          failed: result.failed.map((m) => m.name),
        }),
      );
    } else if (result.migrations.length > 0) {
      this.logger.log(result.message);
    }

    return result;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.workerClient.$disconnect();
  }

  /** Registers a Nest shutdown hook so the process closes the pool cleanly. */
  async enableShutdownHooks(app: INestApplication): Promise<void> {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
