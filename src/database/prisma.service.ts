import { INestApplication, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { createSlowQueryMiddleware } from './slow-query.logger';

/**
 * The single Prisma client for the application. Manages connection lifecycle
 * and exposes graceful shutdown hooks. All repositories depend on this service.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Optional() private readonly configService?: ConfigService) {
    super({
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
  }

  /** Registers a Nest shutdown hook so the process closes the pool cleanly. */
  async enableShutdownHooks(app: INestApplication): Promise<void> {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
