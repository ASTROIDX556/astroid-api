import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Response } from 'express';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';

describe('HealthController', () => {
  let controller: HealthController;
  let dbHealth: { check: ReturnType<typeof vi.fn> };
  let redisHealth: { checkHealth: ReturnType<typeof vi.fn> };
  let stellarHealth: { checkHealth: ReturnType<typeof vi.fn> };
  let migrationHealth: { isEnabled: boolean; checkHealth: ReturnType<typeof vi.fn> };
  let res: Partial<Response>;

  /** Builds the Terminus result map the Prisma indicator returns. */
  const terminus = (overrides: Record<string, unknown> = {}) => ({
    database: {
      status: 'up',
      latencyMs: 5,
      timestamp: new Date().toISOString(),
      ...overrides,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();

    dbHealth = { check: vi.fn().mockResolvedValue(terminus()) };
    redisHealth = {
      checkHealth: vi.fn().mockResolvedValue({
        status: 'up',
        latencyMs: 2,
        timestamp: new Date().toISOString(),
      }),
    };
    stellarHealth = {
      checkHealth: vi.fn().mockResolvedValue({
        status: 'up',
        timestamp: new Date().toISOString(),
        network: 'testnet',
        horizon: { status: 'up', latencyMs: 50, url: 'https://horizon' },
        sorobanRpc: { status: 'up', latencyMs: 40, url: 'https://soroban' },
      }),
    };
    migrationHealth = {
      isEnabled: true,
      checkHealth: vi.fn().mockResolvedValue({
        status: 'up',
        timestamp: new Date().toISOString(),
        pendingMigrations: 0,
        lastMigrationName: '2026_init',
        lastMigrationApplied: new Date().toISOString(),
      }),
    };

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    controller = new HealthController(
      dbHealth as unknown as PrismaHealthIndicator,
      redisHealth as unknown as RedisHealthIndicator,
      stellarHealth as unknown as StellarHealthIndicator,
      migrationHealth as unknown as DatabaseMigrationHealthIndicator,
    );
  });

  it('returns liveness payload with status up', () => {
    const response = controller.getLiveness();
    expect(response.status).toBe('up');
    expect(response.timestamp).toBeDefined();
  });

  describe('GET /health/database', () => {
    it('returns 200 with status and latency when the database answers', async () => {
      await controller.getDatabase(res as Response);

      expect(dbHealth.check).toHaveBeenCalledWith('database');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'up', latencyMs: 5, timestamp: expect.any(String) }),
      );
    });

    it('returns 503 with the failure detail when the probe fails', async () => {
      dbHealth.check.mockResolvedValue(
        terminus({ status: 'down', error: 'PrismaClientInitializationError', message: 'timeout' }),
      );

      await controller.getDatabase(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'down', error: 'timeout' }),
      );
    });

    it('returns 503 when the indicator produces no result at all', async () => {
      dbHealth.check.mockResolvedValue({});

      await controller.getDatabase(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'down' }));
    });

    it('reports only the database, so a broken Redis cannot mask a DB outage', async () => {
      dbHealth.check.mockResolvedValue(
        terminus({ status: 'down', message: 'connection pool exhausted' }),
      );
      redisHealth.checkHealth.mockResolvedValue({ status: 'up', timestamp: 'now' });

      await controller.getDatabase(res as Response);

      expect(redisHealth.checkHealth).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'down', error: 'connection pool exhausted' }),
      );
    });
  });

  describe('GET /health/redis', () => {
    it('returns 200 with status and latency when the PING answers', async () => {
      await controller.getRedis(res as Response);

      expect(redisHealth.checkHealth).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'up', latencyMs: 2, timestamp: expect.any(String) }),
      );
    });

    it('returns 503 with the failure detail when the ping fails', async () => {
      redisHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 3000,
        timestamp: new Date().toISOString(),
        error: 'Redis ping timed out',
      });

      await controller.getRedis(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'down', error: 'Redis ping timed out', latencyMs: 3000 }),
      );
    });

    it('reports only Redis, so a broken database cannot mask a Redis outage', async () => {
      redisHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 12,
        timestamp: new Date().toISOString(),
        error: 'connect ECONNREFUSED',
      });
      dbHealth.check.mockResolvedValue(terminus({ status: 'down', message: 'pool exhausted' }));

      await controller.getRedis(res as Response);

      expect(dbHealth.check).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'down', error: 'connect ECONNREFUSED' }),
      );
    });
  });

  it('returns 200 OK when all services are healthy', async () => {
    await controller.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'up',
        services: expect.objectContaining({
          database: expect.objectContaining({ status: 'up', latencyMs: 5 }),
          redis: expect.objectContaining({ status: 'up' }),
          stellar: expect.objectContaining({ status: 'up' }),
          migrations: expect.objectContaining({ status: 'up' }),
        }),
      }),
    );
  });

  it('asks the Prisma indicator for a result keyed by `database`', async () => {
    await controller.getReadiness(res as Response);

    expect(dbHealth.check).toHaveBeenCalledWith('database');
  });

  it('flattens the Terminus message into the flat `error` field', async () => {
    dbHealth.check.mockResolvedValue(
      terminus({ status: 'down', error: 'PrismaClientInitializationError', message: 'no route to host' }),
    );

    await controller.getReadiness(res as Response);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        services: expect.objectContaining({
          database: expect.objectContaining({
            status: 'down',
            error: 'no route to host',
            latencyMs: 5,
          }),
        }),
      }),
    );
  });

  it('returns 503 SERVICE UNAVAILABLE when database is down', async () => {
    dbHealth.check.mockResolvedValue(
      terminus({
        status: 'down',
        error: 'PrismaClientInitializationError',
        message: 'PrismaClientInitializationError',
      }),
    );

    await controller.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'down',
        services: expect.objectContaining({
          database: expect.objectContaining({ status: 'down' }),
        }),
      }),
    );
  });

  it('returns 503 SERVICE UNAVAILABLE when the database indicator returns no result', async () => {
    dbHealth.check.mockResolvedValue({});

    await controller.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        services: expect.objectContaining({
          database: expect.objectContaining({ status: 'down' }),
        }),
      }),
    );
  });

  it('returns 503 SERVICE UNAVAILABLE when redis is down', async () => {
    redisHealth.checkHealth.mockResolvedValue({
      status: 'down',
      latencyMs: 3000,
      timestamp: new Date().toISOString(),
      error: 'Redis ping timed out',
    });

    await controller.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'down',
        services: expect.objectContaining({
          redis: expect.objectContaining({ status: 'down' }),
        }),
      }),
    );
  });

  it('serves the same payload from the default health route', async () => {
    await controller.check(res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});
