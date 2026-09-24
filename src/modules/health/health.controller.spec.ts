import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Response } from 'express';
import { HealthController } from './health.controller';
import { DatabaseConnectionHealthIndicator } from './indicators/database-connection.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';

describe('HealthController', () => {
  let controller: HealthController;
  let dbHealth: { checkHealth: ReturnType<typeof vi.fn> };
  let redisHealth: { checkHealth: ReturnType<typeof vi.fn> };
  let stellarHealth: { checkHealth: ReturnType<typeof vi.fn> };
  let migrationHealth: { isEnabled: boolean; checkHealth: ReturnType<typeof vi.fn> };
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();

    dbHealth = {
      checkHealth: vi.fn().mockResolvedValue({
        status: 'up',
        latencyMs: 5,
        timestamp: new Date().toISOString(),
      }),
    };

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
      dbHealth as unknown as DatabaseConnectionHealthIndicator,
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

  it('returns 200 OK when all services are healthy', async () => {
    await controller.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'up',
        services: expect.objectContaining({
          database: expect.objectContaining({ status: 'up' }),
          redis: expect.objectContaining({ status: 'up' }),
          stellar: expect.objectContaining({ status: 'up' }),
          migrations: expect.objectContaining({ status: 'up' }),
        }),
      }),
    );
  });

  it('returns 503 SERVICE UNAVAILABLE when database is down', async () => {
    dbHealth.checkHealth.mockResolvedValue({
      status: 'down',
      latencyMs: 10,
      timestamp: new Date().toISOString(),
      error: 'PrismaClientInitializationError',
    });

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
});
