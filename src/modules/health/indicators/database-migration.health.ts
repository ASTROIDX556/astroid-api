import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';

export interface MigrationHealthReport {
  status: 'up' | 'down' | 'degraded';
  timestamp: string;
  pendingMigrations: number;
  lastMigrationName: string | null;
  lastMigrationApplied: string | null;
  error?: string;
}

/**
 * A Prisma migration row as returned by the raw query against
 * `_prisma_migrations`.
 */
interface PrismaMigrationRow {
  migration_name: string;
  started_at: Date;
  finished_at: Date | null;
  applied_steps_count: number;
  checksum: string;
  rolled_back_at: Date | null;
}

/**
 * Health indicator that verifies whether the database schema is fully up to
 * date with the Prisma migration history. Queries the `_prisma_migrations`
 * table to detect pending (unapplied) migrations, returning a 503-style
 * response when the schema is out of date.
 *
 * This is critical for Kubernetes liveness/readiness probes — an application
 * running against an unmigrated database will produce runtime errors on
 * agent request execution.
 *
 * The check is gated behind a configurable toggle
 * (`HEALTH_CHECK_MIGRATIONS_ENABLED`) so it can be disabled in local
 * development while remaining active in production.
 */
@Injectable()
export class DatabaseMigrationHealthIndicator {
  private readonly logger = new Logger(DatabaseMigrationHealthIndicator.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the configured migration check toggle. When `false`, the health
   * endpoint should skip this indicator entirely.
   */
  get isEnabled(): boolean {
    // Default to true — migrations should be checked in production.
    // Set HEALTH_CHECK_MIGRATIONS_ENABLED=false to disable in dev.
    const raw = process.env.HEALTH_CHECK_MIGRATIONS_ENABLED;
    if (raw === undefined) return true;
    return raw !== 'false';
  }

  /**
   * Queries the `_prisma_migrations` table to determine whether any
   * migrations have not yet been applied. Returns a structured report
   * suitable for inclusion in the health endpoint response.
   */
  async checkHealth(): Promise<MigrationHealthReport> {
    try {
      // Raw query is safe here — _prisma_migrations is a Prisma-managed
      // internal table with a fixed schema.
      const rows = await this.prisma.$queryRaw<PrismaMigrationRow[]>`
        SELECT
          migration_name,
          started_at,
          finished_at,
          applied_steps_count,
          checksum,
          rolled_back_at
        FROM _prisma_migrations
        WHERE rolled_back_at IS NULL
        ORDER BY started_at DESC
      `;

      const pendingMigrations = rows.filter((r) => r.finished_at === null).length;
      const completedMigrations = rows.filter((r) => r.finished_at !== null);
      const lastApplied = completedMigrations[0] ?? null;

      let status: 'up' | 'down' | 'degraded' = 'up';
      if (pendingMigrations > 0) {
        status = 'degraded';
        this.logger.warn(
          `Database has ${pendingMigrations} pending migration(s) — schema may be out of date`,
        );
      }

      return {
        status,
        timestamp: new Date().toISOString(),
        pendingMigrations,
        lastMigrationName: lastApplied?.migration_name ?? null,
        lastMigrationApplied: lastApplied?.finished_at?.toISOString() ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Migration health check failed: ${message}`);

      return {
        status: 'down',
        timestamp: new Date().toISOString(),
        pendingMigrations: -1,
        lastMigrationName: null,
        lastMigrationApplied: null,
        error: message,
      };
    }
  }
}
