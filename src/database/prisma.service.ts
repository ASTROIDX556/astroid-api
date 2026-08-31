import { INestApplication, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { DatabaseConfig } from '../config/database.config';
import { buildDatasourceUrl } from './datasource-url';
import { createQueryTimeoutExtension } from './query-timeout.extension';

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

  /**
   * Dedicated client for background workers. It uses its own (smaller) pool
   * sized by `DATABASE_WORKER_CONNECTION_LIMIT`, carries no server-side
   * `statement_timeout`, and enforces the much longer
   * `DATABASE_WORKER_QUERY_TIMEOUT_MS` guard. Workers that run long
   * transactions (rollups, outbox drains, webhook persistence) should use this
   * client so their work is never aborted by API request timeouts.
   */
  readonly workerClient: PrismaClient;

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

    // Inject the timeout-guard extension into this (API) client. `$extends`
    // returns a new client; copying its delegates onto `this` keeps the
    // PrismaService identity every repository already depends on. The cast is
    // required because the generated `$extends` return type is a dynamic
    // extension type rather than a full `PrismaClient`.
    Object.assign(
      this,
      this.$extends(
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
    // Same cast rationale as above: the generated `$extends` return type is a
    // dynamic extension type, not a full `PrismaClient`.
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
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      await this.workerClient.$connect();
      this.logger.log('Prisma connected to the database');
    } catch (error) {
      // Do not crash on boot when the DB is unavailable (e.g. typecheck/build,
      // or during local development before `docker compose up`). Log and go on.
      this.logger.warn(
        `Prisma could not connect on startup: ${(error as Error).message}. ` +
          'The API will retry lazily on first query.',
      );
    }
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
