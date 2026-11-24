import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PublicRateLimitGuard } from '../../common/guards/public-rate-limit.guard';
import { Public } from '../../common/decorators/public.decorator';
import { REDIS_CLIENT } from '../../common/locks/locks.constants';
import { GLOBAL_PREFIX_EXCLUDED_ROUTES } from '../../common/constants/global-prefix';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { QueueHealthIndicator } from './indicators/queue.health';

/** A public route that is not a probe, to prove the public limiter is live here. */
@Controller('probe-control')
@Public()
class PublicControlController {
  @Get()
  ping() {
    return { ok: true };
  }
}

/** Public limit used here: low enough that a burst of probes would hit it. */
const PUBLIC_LIMIT = 2;

/**
 * HTTP-level coverage for the orchestrator probes: real routing, the global
 * authentication guard, the global per-IP public rate limiter, and the same
 * prefix exclusions `main.ts` applies. The indicators are stubbed so dependency
 * outages can be simulated deterministically.
 */
describe('Health probes over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;

  const dbIndicator = { check: vi.fn() };
  const redisIndicator = { checkHealth: vi.fn() };
  const stellarIndicator = { checkHealth: vi.fn(), checkSorobanRpcHealth: vi.fn() };
  const queueIndicator = { checkHealth: vi.fn() };

  const databaseUp = () => ({
    database: { status: 'up', latencyMs: 3, timestamp: new Date().toISOString() },
  });
  const cacheUp = () => ({ status: 'up', latencyMs: 1, timestamp: new Date().toISOString() });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, PublicControlController],
      providers: [
        { provide: APP_GUARD, useClass: PublicRateLimitGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => ({
              public: {
                enabled: true,
                maxRequests: PUBLIC_LIMIT,
                windowSeconds: 60,
                trustProxy: false,
                clientIdentifiers: [],
              },
            }),
            get: () => ({ apiPrefix: 'api/v1' }),
          },
        },
        // A closed client: the public limiter falls back to its in-memory window.
        { provide: REDIS_CLIENT, useValue: { status: 'end' } },
        { provide: PrismaHealthIndicator, useValue: dbIndicator },
        { provide: RedisHealthIndicator, useValue: redisIndicator },
        { provide: StellarHealthIndicator, useValue: stellarIndicator },
        { provide: QueueHealthIndicator, useValue: queueIndicator },
        { provide: DatabaseMigrationHealthIndicator, useValue: { checkHealth: vi.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1', { exclude: GLOBAL_PREFIX_EXCLUDED_ROUTES });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbIndicator.check.mockReset().mockResolvedValue(databaseUp());
    redisIndicator.checkHealth.mockReset().mockResolvedValue(cacheUp());
    queueIndicator.checkHealth.mockReset().mockResolvedValue(cacheUp());
    stellarIndicator.checkSorobanRpcHealth
      .mockReset()
      .mockResolvedValue({ status: 'up', latencyMs: 40, url: 'https://soroban' });
  });

  it('serves GET /health/live without credentials and outside the API prefix', async () => {
    const res = await fetch(`${baseUrl}/health/live`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { status: 'up' },
      meta: {},
      requestId: expect.any(String),
    });
  });

  it('serves GET /health/ready without credentials with 200 when dependencies are up', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: {
        status: 'up',
        services: {
          database: { status: 'up', latencyMs: 3 },
          cache: { status: 'up', latencyMs: 1 },
          queue: { status: 'up', latencyMs: 1 },
          soroban: { status: 'up', latencyMs: 40 },
        },
      },
    });
  });

  it('answers GET /health/ready with 503 when the Soroban RPC is down', async () => {
    stellarIndicator.checkSorobanRpcHealth.mockResolvedValue({
      status: 'down',
      latencyMs: 2000,
      url: 'https://soroban.internal',
      error: 'Soroban RPC health check timed out after 2000ms',
    });

    const res = await fetch(`${baseUrl}/health/ready`);
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      data: {
        status: 'down',
        services: {
          database: { status: 'up' },
          cache: { status: 'up' },
          queue: { status: 'up' },
          soroban: { status: 'down', error: 'timeout' },
        },
      },
    });
    expect(text).not.toMatch(/soroban\.internal|https:/);
  });

  it('answers GET /health/ready with 503 when only the queue connection is down', async () => {
    queueIndicator.checkHealth.mockResolvedValue({
      status: 'down',
      latencyMs: 4,
      timestamp: new Date().toISOString(),
      error: 'getaddrinfo ENOTFOUND redis.internal',
    });

    const res = await fetch(`${baseUrl}/health/ready`);
    const text = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({
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
    expect(text).not.toMatch(/ENOTFOUND|redis\.internal/);
  });

  it('answers GET /health/ready with 503 and structured detail during a database outage', async () => {
    dbIndicator.check.mockResolvedValue({
      database: {
        status: 'down',
        latencyMs: 2000,
        timestamp: new Date().toISOString(),
        error: 'Error',
        message: 'Database health check timed out after 2000ms',
      },
    });

    const res = await fetch(`${baseUrl}/health/ready`);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      data: {
        status: 'down',
        services: {
          database: { status: 'down', error: 'timeout' },
          cache: { status: 'up' },
        },
      },
    });
  });

  it('carries the caller request id in the probe envelope', async () => {
    const res = await fetch(`${baseUrl}/health/live`, { headers: { 'x-request-id': 'req-probe-7' } });

    expect(await res.json()).toMatchObject({ requestId: 'req-probe-7' });
  });

  it('never answers a probe with 429, however often it is called', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PUBLIC_LIMIT * 5; i++) {
      statuses.push((await fetch(`${baseUrl}/health/live`)).status);
      statuses.push((await fetch(`${baseUrl}/health/ready`)).status);
      statuses.push((await fetch(`${baseUrl}/api/v1/health/database`)).status);
    }

    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  });

  it('still limits a public route that is not a probe (control)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PUBLIC_LIMIT + 1; i++) {
      statuses.push((await fetch(`${baseUrl}/api/v1/probe-control`)).status);
    }

    expect(statuses.at(-1)).toBe(429);
  });

  it('keeps GET /health/live at 200 during a database outage', async () => {
    dbIndicator.check.mockResolvedValue({ database: { status: 'down' } });

    const res = await fetch(`${baseUrl}/health/live`);

    expect(res.status).toBe(200);
  });

  it('keeps the diagnostic routes under the API prefix and public', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health/database`);

    expect(res.status).toBe(200);
  });

  it('serves GET /api/v1/health/stellar with the per-endpoint status', async () => {
    stellarIndicator.checkHealth.mockResolvedValue({
      status: 'up',
      timestamp: new Date().toISOString(),
      network: 'testnet',
      horizon: { status: 'up', latencyMs: 21, url: 'https://horizon' },
      sorobanRpc: { status: 'up', latencyMs: 18, url: 'https://soroban' },
    });

    const res = await fetch(`${baseUrl}/api/v1/health/stellar`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'up',
      horizon: { status: 'up' },
      sorobanRpc: { status: 'up' },
    });
  });

  it('answers GET /api/v1/health/stellar with 503 during a Stellar outage', async () => {
    stellarIndicator.checkHealth.mockResolvedValue({
      status: 'down',
      timestamp: new Date().toISOString(),
      network: 'testnet',
      horizon: { status: 'down', latencyMs: 2000, url: 'https://horizon', error: 'timeout' },
      sorobanRpc: { status: 'up', latencyMs: 18, url: 'https://soroban' },
    });

    const res = await fetch(`${baseUrl}/api/v1/health/stellar`);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'down' });
  });
});
