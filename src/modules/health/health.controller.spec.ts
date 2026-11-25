import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { SKIP_PUBLIC_RATE_LIMIT_KEY } from '../../common/decorators/skip-public-rate-limit.decorator';
import { PrismaService } from '../../database/prisma.service';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { QueueHealthIndicator } from './indicators/queue.health';
import { ShutdownCoordinator } from '../../common/shutdown/shutdown-coordinator.service';

describe('HealthController', () => {
  let controller: HealthController;
  let dbHealth: { check: ReturnType<typeof vi.fn> };
  let redisHealth: { checkHealth: ReturnType<typeof vi.fn> };
  let stellarHealth: {
    checkHealth: ReturnType<typeof vi.fn>;
    checkSorobanRpcHealth: ReturnType<typeof vi.fn>;
  };
  let migrationHealth: { isEnabled: boolean; checkHealth: ReturnType<typeof vi.fn> };
  let queueHealth: { checkHealth: ReturnType<typeof vi.fn> };
  let res: Partial<Response>;
  const req = { headers: { 'x-request-id': 'req-health-1' } } as Partial<Request>;

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
      checkSorobanRpcHealth: vi.fn().mockResolvedValue({
        status: 'up',
        latencyMs: 40,
        url: 'https://soroban',
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

    queueHealth = {
      checkHealth: vi.fn().mockResolvedValue({
        status: 'up',
        latencyMs: 1,
        timestamp: new Date().toISOString(),
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
      queueHealth as unknown as QueueHealthIndicator,
    );
  });

  describe('GET /health/live', () => {
    it('returns 200 in the standard envelope without probing any dependency', () => {
      controller.live(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          status: 'up',
          timestamp: expect.any(String),
          uptimeSeconds: expect.any(Number),
        },
        meta: {},
        requestId: 'req-health-1',
      });
      expect(dbHealth.check).not.toHaveBeenCalled();
      expect(redisHealth.checkHealth).not.toHaveBeenCalled();
      expect(stellarHealth.checkSorobanRpcHealth).not.toHaveBeenCalled();
    });

    it('stays 200 during a database outage', () => {
      dbHealth.check.mockRejectedValue(new Error('ECONNREFUSED'));

      controller.live(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('falls back to `unknown` when the request carries no request id', () => {
      controller.live({ headers: {} } as Request, res as Response);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'unknown' }));
    });
  });

  describe('GET /health/ready', () => {
    const body = () => (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];

    it('returns 200 with per-dependency status and latency when database, cache, queue and Soroban RPC are up', async () => {
      await controller.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          status: 'up',
          timestamp: expect.any(String),
          checks: [
            { name: 'database', status: 'up', latencyMs: 5 },
            { name: 'cache', status: 'up', latencyMs: 2 },
            { name: 'queue', status: 'up', latencyMs: 1 },
            { name: 'soroban', status: 'up', latencyMs: 40 },
          ],
          services: {
            database: { status: 'up', latencyMs: 5, timestamp: expect.any(String) },
            cache: { status: 'up', latencyMs: 2, timestamp: expect.any(String) },
            queue: { status: 'up', latencyMs: 1, timestamp: expect.any(String) },
            soroban: { status: 'up', latencyMs: 40, timestamp: expect.any(String) },
          },
        },
        meta: {},
        requestId: 'req-health-1',
      });
    });

    it('answers 503 not-ready as soon as shutdown starts, without probing any dependency', async () => {
      const closing = new HealthController(
        dbHealth as unknown as PrismaHealthIndicator,
        redisHealth as unknown as RedisHealthIndicator,
        stellarHealth as unknown as StellarHealthIndicator,
        migrationHealth as unknown as DatabaseMigrationHealthIndicator,
        queueHealth as unknown as QueueHealthIndicator,
        { isShuttingDown: true } as unknown as ShutdownCoordinator,
      );

      await closing.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body()).toMatchObject({
        success: false,
        data: {
          status: 'down',
          reason: 'shutting_down',
          services: {
            database: { status: 'down', error: 'unavailable' },
            cache: { status: 'down', error: 'unavailable' },
            queue: { status: 'down', error: 'unavailable' },
            soroban: { status: 'down', error: 'unavailable' },
          },
        },
      });
      expect(dbHealth.check).not.toHaveBeenCalled();
      expect(redisHealth.checkHealth).not.toHaveBeenCalled();
      expect(queueHealth.checkHealth).not.toHaveBeenCalled();
      expect(stellarHealth.checkSorobanRpcHealth).not.toHaveBeenCalled();
    });

    it('returns 503 when only the queue connection is down', async () => {
      queueHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 4,
        timestamp: new Date().toISOString(),
        error: 'Queue connection unavailable',
      });

      await controller.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body()).toMatchObject({
        success: false,
        data: {
          status: 'down',
          services: {
            database: { status: 'up' },
            cache: { status: 'up' },
            queue: { status: 'down', error: 'unavailable' },
          },
        },
      });
    });

    it('reports a queue probe that hit its timeout as `timeout`', async () => {
      queueHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 2000,
        timestamp: new Date().toISOString(),
        error: 'Queue health check timed out after 2000ms',
      });

      await controller.ready(req as Request, res as Response);

      expect(body().data.services.queue).toMatchObject({
        status: 'down',
        error: 'timeout',
        latencyMs: 2000,
      });
    });

    it('does not put the queue driver message in the body', async () => {
      queueHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 1,
        timestamp: new Date().toISOString(),
        error: 'getaddrinfo ENOTFOUND redis.internal',
      });

      await controller.ready(req as Request, res as Response);

      expect(JSON.stringify(body())).not.toMatch(/ENOTFOUND|redis\.internal/);
    });

    it('lists every dependency under `checks` with name, status and latency, even when one is down', async () => {
      redisHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 9,
        timestamp: new Date().toISOString(),
        error: 'connect ECONNREFUSED 10.1.2.3:6379',
      });

      await controller.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body().data.checks).toEqual([
        { name: 'database', status: 'up', latencyMs: 5 },
        { name: 'cache', status: 'down', latencyMs: 9, error: 'unavailable' },
        { name: 'queue', status: 'up', latencyMs: 1 },
        { name: 'soroban', status: 'up', latencyMs: 40 },
      ]);
      expect(JSON.stringify(body())).not.toMatch(/10.1.2.3|6379|ECONNREFUSED/);
    });

    it('passes the configured check timeout to each indicator', async () => {
      await controller.ready(req as Request, res as Response);

      expect(dbHealth.check).toHaveBeenCalledWith('database', 1_000);
      expect(redisHealth.checkHealth).toHaveBeenCalledWith(1_000);
      expect(queueHealth.checkHealth).toHaveBeenCalledWith(1_000);
      expect(stellarHealth.checkSorobanRpcHealth).toHaveBeenCalledWith(1_000);
    });

    it('returns 503 with success false during a simulated database outage', async () => {
      dbHealth.check.mockResolvedValue(
        terminus({
          status: 'down',
          latencyMs: 40,
          error: 'PrismaClientInitializationError',
          message: "Can't reach database server at `db.internal:5432`",
        }),
      );

      await controller.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body()).toMatchObject({
        success: false,
        data: {
          status: 'down',
          services: {
            database: { status: 'down', latencyMs: 40, error: 'unavailable' },
            cache: { status: 'up' },
          },
        },
      });
    });

    it('returns 503 during a simulated cache outage', async () => {
      redisHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 3,
        timestamp: new Date().toISOString(),
        error: 'connect ECONNREFUSED 10.0.4.12:6379',
      });

      await controller.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body()).toMatchObject({
        success: false,
        data: {
          status: 'down',
          services: {
            database: { status: 'up' },
            cache: { status: 'down', error: 'unavailable' },
          },
        },
      });
    });

    it('reports a hit timeout as `timeout` for either dependency', async () => {
      dbHealth.check.mockResolvedValue(
        terminus({ status: 'down', error: 'Error', message: 'Database health check timed out after 2000ms' }),
      );
      redisHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 2000,
        timestamp: new Date().toISOString(),
        error: 'Redis health check timed out after 2000ms',
      });

      await controller.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body().data.services).toMatchObject({
        database: { status: 'down', error: 'timeout' },
        cache: { status: 'down', error: 'timeout', latencyMs: 2000 },
      });
    });

    it('never puts driver messages, hosts or connection strings in the body', async () => {
      dbHealth.check.mockResolvedValue(
        terminus({
          status: 'down',
          error: 'PrismaClientInitializationError',
          message: 'Authentication failed for postgresql://astroid:s3cret@db.internal:5432/astroid',
        }),
      );
      redisHealth.checkHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 1,
        timestamp: new Date().toISOString(),
        error: 'connect ECONNREFUSED 10.0.4.12:6379',
      });

      await controller.ready(req as Request, res as Response);

      const serialized = JSON.stringify(body());
      for (const leaked of ['postgresql://', 's3cret', 'db.internal', '10.0.4.12', '6379', 'Prisma']) {
        expect(serialized).not.toContain(leaked);
      }
    });

    it('returns 503 when the database indicator produces no result', async () => {
      dbHealth.check.mockResolvedValue({});

      await controller.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body().data.services.database).toMatchObject({
        status: 'down',
        error: 'unavailable',
      });
    });

    it('returns 503 when the Soroban RPC is unavailable', async () => {
      stellarHealth.checkSorobanRpcHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 2_000,
        url: 'https://soroban.internal',
        error: 'The operation was aborted',
      });

      await controller.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body()).toMatchObject({
        success: false,
        data: {
          status: 'down',
          services: {
            database: { status: 'up' },
            cache: { status: 'up' },
            queue: { status: 'up' },
            soroban: { status: 'down', error: 'unavailable' },
          },
        },
      });
    });

    it('reports a Soroban RPC probe that hit its timeout as `timeout`', async () => {
      stellarHealth.checkSorobanRpcHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 2_000,
        url: 'https://soroban.internal',
        error: 'Soroban RPC health check timed out after 2000ms',
      });

      await controller.ready(req as Request, res as Response);

      expect(body().data.services.soroban).toMatchObject({
        status: 'down',
        error: 'timeout',
        latencyMs: 2_000,
      });
    });

    it('does not put the Soroban endpoint or driver message in the body', async () => {
      stellarHealth.checkSorobanRpcHealth.mockResolvedValue({
        status: 'down',
        latencyMs: 10,
        url: 'https://soroban.internal:443/rpc',
        error: 'getaddrinfo ENOTFOUND soroban.internal',
      });

      await controller.ready(req as Request, res as Response);

      expect(JSON.stringify(body())).not.toMatch(/ENOTFOUND|soroban\.internal|https:/);
    });

    it('returns 503 when several dependencies fail at once', async () => {
      dbHealth.check.mockResolvedValue(terminus({ status: 'down', error: 'Error' }));
      redisHealth.checkHealth.mockResolvedValue({ status: 'down', latencyMs: 2_000, error: 'timeout' });
      stellarHealth.checkSorobanRpcHealth.mockResolvedValue({ status: 'down', latencyMs: 2_000 });

      await controller.ready(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body().data).toMatchObject({
        status: 'down',
        services: {
          database: { status: 'down' },
          cache: { status: 'down' },
          queue: { status: 'up' },
          soroban: { status: 'down' },
        },
      });
    });

    it('checks only the Soroban RPC, so a Horizon outage cannot fail readiness', async () => {
      stellarHealth.checkHealth.mockResolvedValue({
        status: 'down',
        timestamp: 'now',
        network: 'testnet',
        horizon: { status: 'down', latencyMs: 2_000, url: 'https://horizon', error: 'timeout' },
        sorobanRpc: { status: 'up', latencyMs: 20, url: 'https://soroban' },
      });

      await controller.ready(req as Request, res as Response);

      expect(stellarHealth.checkSorobanRpcHealth).toHaveBeenCalledTimes(1);
      expect(stellarHealth.checkHealth).not.toHaveBeenCalled();
      expect(migrationHealth.checkHealth).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('readiness timeouts with the real indicators', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('answers 503 once the 1s timeout fires when the database hangs', async () => {
      vi.useFakeTimers();
      const hung = new Promise<never>(() => undefined);
      const prisma = { $queryRaw: vi.fn(() => hung) } as unknown as PrismaService;
      const redis = { status: 'ready', ping: vi.fn().mockResolvedValue('PONG') } as unknown as Redis;
      const real = new HealthController(
        new PrismaHealthIndicator(prisma),
        new RedisHealthIndicator(redis),
        stellarHealth as unknown as StellarHealthIndicator,
        migrationHealth as unknown as DatabaseMigrationHealthIndicator,
        queueHealth as unknown as QueueHealthIndicator,
      );

      const pending = real.ready(req as Request, res as Response);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body().data.services).toMatchObject({
        database: { status: 'down', error: 'timeout' },
        cache: { status: 'up' },
      });
    });

    it('answers 503 once the 1s timeout fires when Redis hangs', async () => {
      vi.useFakeTimers();
      const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) } as unknown as PrismaService;
      const redis = {
        status: 'ready',
        ping: vi.fn(() => new Promise<never>(() => undefined)),
      } as unknown as Redis;
      const real = new HealthController(
        new PrismaHealthIndicator(prisma),
        new RedisHealthIndicator(redis),
        stellarHealth as unknown as StellarHealthIndicator,
        migrationHealth as unknown as DatabaseMigrationHealthIndicator,
        queueHealth as unknown as QueueHealthIndicator,
      );

      const pending = real.ready(req as Request, res as Response);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      expect(res.status).toHaveBeenCalledWith(503);
      expect(body().data.services).toMatchObject({
        database: { status: 'up' },
        cache: { status: 'down', error: 'timeout' },
      });
    });

    function body() {
      return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    }
  });

  it('returns liveness payload with status up', () => {
    const response = controller.getLiveness();
    expect(response.status).toBe('up');
    expect(response.timestamp).toBeDefined();
  });

  it('serves each orchestrator probe from exactly one handler', () => {
    const path = (handler: unknown) => Reflect.getMetadata(PATH_METADATA, handler as object);

    expect(path(HealthController.prototype.live)).toBe('live');
    expect(path(HealthController.prototype.ready)).toBe('ready');
    expect(path(HealthController.prototype.getLiveness)).toBe('liveness');
    // A second `ready` path here is shadowed by `ready()` at runtime, while the
    // OpenAPI document describes this handler in its place.
    expect(path(HealthController.prototype.getReadiness)).toBe('readiness');
  });

  it('is exempt from authentication and from the public IP limiter', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, HealthController)).toBe(true);
    expect(Reflect.getMetadata(SKIP_PUBLIC_RATE_LIMIT_KEY, HealthController)).toBe(true);
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

  describe('GET /health/stellar', () => {
    it('returns 200 with the per-endpoint status when both Stellar endpoints answer', async () => {
      await controller.getStellar(res as Response);

      expect(stellarHealth.checkHealth).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'up',
          network: 'testnet',
          horizon: expect.objectContaining({ status: 'up' }),
          sorobanRpc: expect.objectContaining({ status: 'up' }),
        }),
      );
    });

    it('returns 503 with the failure detail when the Soroban RPC is unreachable', async () => {
      stellarHealth.checkHealth.mockResolvedValue({
        status: 'down',
        timestamp: new Date().toISOString(),
        network: 'testnet',
        horizon: { status: 'up', latencyMs: 50, url: 'https://horizon' },
        sorobanRpc: {
          status: 'down',
          latencyMs: 2000,
          url: 'https://soroban',
          error: 'The operation was aborted',
        },
      });

      await controller.getStellar(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'down',
          sorobanRpc: expect.objectContaining({
            status: 'down',
            error: 'The operation was aborted',
          }),
        }),
      );
    });

    it('returns 503 when an endpoint is only degraded', async () => {
      stellarHealth.checkHealth.mockResolvedValue({
        status: 'degraded',
        timestamp: new Date().toISOString(),
        network: 'testnet',
        horizon: { status: 'degraded', latencyMs: 1500, url: 'https://horizon' },
        sorobanRpc: { status: 'up', latencyMs: 40, url: 'https://soroban' },
      });

      await controller.getStellar(res as Response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'degraded' }),
      );
    });

    it('reports only Stellar, so a broken database cannot mask a Stellar outage', async () => {
      stellarHealth.checkHealth.mockResolvedValue({
        status: 'down',
        timestamp: new Date().toISOString(),
        network: 'testnet',
        horizon: { status: 'down', latencyMs: 10, url: 'https://horizon', error: 'ECONNREFUSED' },
        sorobanRpc: { status: 'up', latencyMs: 40, url: 'https://soroban' },
      });
      dbHealth.check.mockResolvedValue(terminus({ status: 'down', message: 'pool exhausted' }));

      await controller.getStellar(res as Response);

      expect(dbHealth.check).not.toHaveBeenCalled();
      expect(redisHealth.checkHealth).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
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

  it('reports every diagnostic dependency down while shutting down', async () => {
    const closing = new HealthController(
      dbHealth as unknown as PrismaHealthIndicator,
      redisHealth as unknown as RedisHealthIndicator,
      stellarHealth as unknown as StellarHealthIndicator,
      migrationHealth as unknown as DatabaseMigrationHealthIndicator,
      queueHealth as unknown as QueueHealthIndicator,
      { isShuttingDown: true } as unknown as ShutdownCoordinator,
    );

    await closing.getReadiness(res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'down',
        reason: 'shutting_down',
        services: {
          database: expect.objectContaining({ status: 'down' }),
          redis: expect.objectContaining({ status: 'down' }),
          stellar: expect.objectContaining({ status: 'down' }),
          migrations: expect.objectContaining({ status: 'down' }),
        },
      }),
    );
    expect(stellarHealth.checkHealth).not.toHaveBeenCalled();
  });

  it('serves the same payload from the default health route', async () => {
    await controller.check(res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});
