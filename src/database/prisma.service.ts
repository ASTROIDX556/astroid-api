import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { DatabaseConfig } from '../config/database.config';
import { buildDatasourceUrl } from './datasource-url';
import { createQueryMetricsExtension } from './query-metrics.extension';
import { createQueryTimeoutExtension } from './query-timeout.extension';
import {
  MigrationCheckMode,
  MigrationCheckResult,
  verifyMigrationsOnStartup,
} from './migration-checker';

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
  private readonly connectionRetryAttempts: number;
  private readonly connectionRetryDelayMs: number;

  /**
   * Dedicated client for background workers. It uses its own (smaller) pool
   * sized by `DATABASE_WORKER_CONNECTION_LIMIT`, carries no server-side
   * `statement_timeout`, and enforces the much longer
   * `DATABASE_WORKER_QUERY_TIMEOUT_MS` guard. Workers that run long
   * transactions (rollups, outbox drains, webhook persistence) should use this
   * client so their work is never aborted by API request timeouts.
   */
  readonly workerClient: PrismaClient;

  private readonly migrationCheck: MigrationCheckMode;
  private readonly migrationsDir?: string;

  constructor(configService: ConfigService) {
    const database = configService.getOrThrow<DatabaseConfig>('database');

    const url = buildDatasourceUrl(database.url, {
      connectionLimit: database.connectionLimit,
      poolTimeoutMs: database.poolTimeoutMs,
      statementTimeoutMs: database.statementTimeoutMs,
    });

    super({
      datasources: { db: { url } },
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });
    this.connectionRetryAttempts = database.connectionRetryAttempts;
    this.connectionRetryDelayMs = database.connectionRetryDelayMs;

    // Inject the metrics + timeout-guard extensions into this (API) client.
    // `$extends` returns a new client; copying its delegates onto `this` keeps
    // the PrismaService identity every repository already depends on.
    Object.assign(
      this,
      this.$extends(createQueryMetricsExtension({ slowQueryThresholdMs: database.slowQueryThresholdMs }))
          .$extends(
            createQueryTimeoutExtension({
              queryTimeoutMs: database.queryTimeoutMs,
              poolTimeoutMs: database.poolTimeoutMs,
            }),
          ) as unknown as PrismaClient,
    );

    // Dedicated worker pool: smaller, extended timeout, no statement_timeout.
    const workerUrl = buildDatasourceUrl(database.url, {
      connectionLimit: database.workerConnectionLimit,
      poolTimeoutMs: database.poolTimeoutMs,
      statementTimeoutMs: 0,
    });
    this.workerClient = new PrismaClient({
      datasources: { db: { url: workerUrl } },
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    }).$extends(
      createQueryTimeoutExtension({
        queryTimeoutMs: database.workerQueryTimeoutMs,
        poolTimeoutMs: database.poolTimeoutMs,
      }),
    ) as unknown as PrismaClient;

    this.migrationCheck = database.migrationCheck;
    this.migrationsDir = database.migrationsDir;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      await this.workerClient.$connect();
      this.logger.log('Prisma connected to the database');
    } catch (error) {
      // Do not crash on boot when the DB is unavailable (e.g. typecheck/build,
      // or during local development before `docker compose up`). Log and go on.
      // Whether the process may then serve traffic is decided by
      // `verifyMigrations()`, which `main.ts` runs before listening.
      this.logger.warn(
        `Prisma could not connect on startup: ${(error as Error).message}. ` +
          'The API will retry lazily on first query.',
      );
    })
      .$extends(createQueryMetricsExtension({ slowQueryThresholdMs: database.slowQueryThresholdMs }))
      .$extends(
        createQueryTimeoutExtension({
          queryTimeoutMs: database.workerQueryTimeoutMs,
          poolTimeoutMs: database.poolTimeoutMs,
        }),
      ) as unknown as PrismaClient;
  }

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry('API', () => this.$connect());
    await this.connectWithRetry('worker', () => this.workerClient.$connect());
    await this.validateMigrations();
    this.logger.log('Prisma connected to the database and migrations are up to date');
  }

  private async connectWithRetry(pool: string, connect: () => Promise<void>): Promise<void> {
    for (let attempt = 1; attempt <= this.connectionRetryAttempts; attempt += 1) {
      try {
        await connect();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === this.connectionRetryAttempts) {
          this.logger.error(
            `Prisma ${pool} database connection failed after ${attempt} attempt(s): ${message}`,
          );
          throw error;
        }

        const delayMs = Math.min(this.connectionRetryDelayMs * 2 ** (attempt - 1), 30_000);
        this.logger.warn(
          `Prisma ${pool} database connection attempt ${attempt}/${this.connectionRetryAttempts} failed: ${message}. Retrying in ${delayMs}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Verifies that every migration shipped with this build has been applied.
   * Called by `main.ts` before the HTTP server starts listening. In `strict`
   * mode (the production default) pending/failed migrations, or a database
   * whose migration history cannot be read, throw and abort startup; in `warn`
   * mode they are logged with remediation steps; `off` skips the check.
   */
  async verifyMigrations(): Promise<MigrationCheckResult | null> {
    return verifyMigrationsOnStartup(this, {
      mode: this.migrationCheck,
      migrationsDir: this.migrationsDir,
      logger: this.logger,
    });
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

    if (!result.upToDate) {
      throw new Error(`Database migrations are not up to date: ${result.message}`);
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
