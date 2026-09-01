import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { DatabaseMigrationHealthIndicator } from './database-migration.health';
import { PrismaService } from '../../../database/prisma.service';

describe('DatabaseMigrationHealthIndicator', () => {
  let prisma: { $queryRaw: ReturnType<typeof vi.fn> };
  let indicator: DatabaseMigrationHealthIndicator;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();

    prisma = {
      $queryRaw: vi.fn(),
    };

    indicator = new DatabaseMigrationHealthIndicator(
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('isEnabled', () => {
    it('defaults to true when the env var is not set', () => {
      expect(indicator.isEnabled).toBe(true);
    });

    it('returns true when env var is set to "true"', () => {
      vi.stubEnv('HEALTH_CHECK_MIGRATIONS_ENABLED', 'true');
      expect(indicator.isEnabled).toBe(true);
    });

    it('returns false when env var is set to "false"', () => {
      vi.stubEnv('HEALTH_CHECK_MIGRATIONS_ENABLED', 'false');
      expect(indicator.isEnabled).toBe(false);
    });
  });

  describe('checkHealth', () => {
    it('returns UP when all migrations are applied', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          migration_name: '20260801_add_budgets',
          started_at: new Date('2026-08-01T00:00:00.000Z'),
          finished_at: new Date('2026-08-01T00:00:05.000Z'),
          applied_steps_count: 3,
          checksum: 'abc123',
          rolled_back_at: null,
        },
        {
          migration_name: '20260701_init',
          started_at: new Date('2026-07-01T00:00:00.000Z'),
          finished_at: new Date('2026-07-01T00:00:10.000Z'),
          applied_steps_count: 5,
          checksum: 'def456',
          rolled_back_at: null,
        },
      ]);

      const report = await indicator.checkHealth();

      expect(report.status).toBe('up');
      expect(report.pendingMigrations).toBe(0);
      expect(report.lastMigrationName).toBe('20260801_add_budgets');
      expect(report.lastMigrationApplied).toBe('2026-08-01T00:00:05.000Z');
      expect(report.error).toBeUndefined();
    });

    it('returns DEGRADED when there are pending (unfinished) migrations', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          migration_name: '20260815_add_locks',
          started_at: new Date('2026-08-15T00:00:00.000Z'),
          finished_at: null, // pending!
          applied_steps_count: 0,
          checksum: 'ghi789',
          rolled_back_at: null,
        },
        {
          migration_name: '20260801_add_budgets',
          started_at: new Date('2026-08-01T00:00:00.000Z'),
          finished_at: new Date('2026-08-01T00:00:05.000Z'),
          applied_steps_count: 3,
          checksum: 'abc123',
          rolled_back_at: null,
        },
      ]);

      const report = await indicator.checkHealth();

      expect(report.status).toBe('degraded');
      expect(report.pendingMigrations).toBe(1);
      expect(report.lastMigrationName).toBe('20260801_add_budgets');
    });

    it('counts multiple pending migrations correctly', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          migration_name: '20260901_pending_a',
          started_at: new Date(),
          finished_at: null,
          applied_steps_count: 0,
          checksum: 'aaa',
          rolled_back_at: null,
        },
        {
          migration_name: '20260915_pending_b',
          started_at: new Date(),
          finished_at: null,
          applied_steps_count: 0,
          checksum: 'bbb',
          rolled_back_at: null,
        },
        {
          migration_name: '20260801_done',
          started_at: new Date(),
          finished_at: new Date(),
          applied_steps_count: 2,
          checksum: 'ccc',
          rolled_back_at: null,
        },
      ]);

      const report = await indicator.checkHealth();

      expect(report.status).toBe('degraded');
      expect(report.pendingMigrations).toBe(2);
      expect(report.lastMigrationName).toBe('20260801_done');
    });

    it('returns DOWN when the database query fails', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('Connection refused'));

      const report = await indicator.checkHealth();

      expect(report.status).toBe('down');
      expect(report.pendingMigrations).toBe(-1);
      expect(report.error).toContain('Connection refused');
      expect(report.lastMigrationName).toBeNull();
      expect(report.lastMigrationApplied).toBeNull();
    });

    it('returns UP with null last migration when no migrations exist', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const report = await indicator.checkHealth();

      expect(report.status).toBe('up');
      expect(report.pendingMigrations).toBe(0);
      expect(report.lastMigrationName).toBeNull();
      expect(report.lastMigrationApplied).toBeNull();
    });

    it('includes a timestamp in the report', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const report = await indicator.checkHealth();

      expect(report.timestamp).toBeDefined();
      // Should be a valid ISO string
      expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
    });
  });
});
