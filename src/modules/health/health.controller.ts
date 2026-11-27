import { Controller, Get, Optional, Req, Res, HttpStatus } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { HealthIndicatorResult } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { SkipAudit } from '../../common/decorators/skip-audit.decorator';
import { SkipPublicRateLimit } from '../../common/decorators/skip-public-rate-limit.decorator';
import { SkipCredentialRateLimit } from '../../common/decorators/skip-credential-rate-limit.decorator';
import { ApiEnvelope, ApiEnvelopeDto } from '../../common/decorators/api-envelope.decorator';
import { REQUEST_ID_HEADER } from '../../common/constants/headers';
import { ApiMeta } from '../../common/interfaces/api-response.interface';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { resolveHealthProbeConfig } from '../../config/health.config';
import { QueueHealthIndicator } from './indicators/queue.health';
import { ShutdownCoordinator } from '../../common/shutdown/shutdown-coordinator.service';
import {
  DependencyProbeDto,
  HealthStatusDto,
  LivenessDto,
  ReadinessCheckDto,
  ReadinessDto,
  StellarHealthDto,
} from './health.dto';
import { ReadinessCheck, ReadinessRunner } from './readiness-runner';

/**
 * Body of the orchestrator probes: the standard `{ success, data, meta, requestId }`
 * envelope. The readiness probe answers 503 with `success: false` and the same
 * `data`, so a client reads one shape whatever the outcome.
 */
interface ProbeEnvelope<T> {
  success: boolean;
  data: T;
  meta: ApiMeta;
  requestId: string;
}

/** Per-dependency report shape returned under `services` in the readiness body. */
interface ReadinessServiceReport {
  status: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Health and probe endpoints. Public (orchestrators and load balancers carry no
 * credentials), excluded from rate limiting so frequent probes can never be
 * answered with a 429 (both the tier throttlers and the per-IP public limiter,
 * which would otherwise apply to every `@Public()` route), and excluded from the
 * audit trail so probes do not write a row per request — or attempt to while the
 * database is down.
 *
 * `GET /health/live` and `GET /health/ready` are the orchestrator probes and are
 * served outside the global API prefix (see `main.ts`); the remaining routes are
 * richer diagnostics served under it.
 */
@ApiTags('Health')
@Controller('health')
@Public()
@SkipAudit()
@SkipPublicRateLimit()
@SkipCredentialRateLimit()
@SkipThrottle({ api: true, auth: true })
@ApiExtraModels(ApiEnvelopeDto, ReadinessDto, ReadinessCheckDto, DependencyProbeDto)
export class HealthController {
  /**
   * The dependencies `GET /health/ready` gates traffic on. Append an entry (for
   * example the Soroban RPC, with `required: false` while it is advisory) to add
   * a dependency without touching the runner or the handler.
   */
  private readonly readinessChecks: readonly ReadinessCheck[];

  constructor(
    private readonly dbIndicator: PrismaHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly stellarIndicator: StellarHealthIndicator,
    private readonly migrationIndicator: DatabaseMigrationHealthIndicator,
    private readonly queueIndicator: QueueHealthIndicator,
    // Global infrastructure: present in the running app, absent in unit tests
    // that construct the controller directly.
    @Optional() private readonly shutdown?: ShutdownCoordinator,
    @Optional()
    private readonly readinessRunner: ReadinessRunner = new ReadinessRunner(
      resolveHealthProbeConfig(),
    ),
  ) {
    this.readinessChecks = [
      {
        name: 'database',
        run: async (timeoutMs) => unwrap(await this.dbIndicator.check('database', timeoutMs), 'database'),
      },
      { name: 'cache', run: (timeoutMs) => this.redisIndicator.checkHealth(timeoutMs) },
      { name: 'queue', run: (timeoutMs) => this.queueIndicator.checkHealth(timeoutMs) },
      // Only the Soroban RPC is critical: Horizon is probed by the diagnostics
      // endpoint, so a Horizon outage cannot take the API out of rotation.
      { name: 'soroban', run: (timeoutMs) => this.stellarIndicator.checkSorobanRpcHealth(timeoutMs) },
    ];
  }

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 whenever the process is running and able to serve HTTP. Performs no ' +
      'dependency checks, so a downstream outage never causes the orchestrator to restart ' +
      'an otherwise healthy process.',
  })
  @ApiEnvelope(LivenessDto, { description: 'Process is alive' })
  live(@Req() req: Request, @Res() res: Response) {
    const data: LivenessDto = {
      status: 'up',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
    return sendProbe(req, res, HttpStatus.OK, data);
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Probes the critical dependencies (database, cache, the BullMQ queue connection and the ' +
      'Soroban RPC) in parallel, each bounded by a timeout. Returns 200 when every dependency is up and 503 when any is down, with ' +
      'per-dependency status and latency under `data.services`. A failure is reported as ' +
      '`timeout` or `unavailable` only; driver messages stay in the server log. Infrastructure ' +
      'endpoint for orchestrators and load balancers (served outside the versioned API prefix, ' +
      'unauthenticated and not rate limited): it is not part of the public API contract.',
  })
  @ApiEnvelope(ReadinessDto, { description: 'All critical dependencies are reachable' })
  @ApiResponse({
    status: 503,
    description: 'At least one critical dependency is unreachable (`success` is false)',
    schema: {
      allOf: [
        { $ref: getSchemaPath(ApiEnvelopeDto) },
        {
          properties: {
            success: { type: 'boolean', example: false },
            data: { $ref: getSchemaPath(ReadinessDto) },
          },
        },
      ],
    },
  })
  async ready(@Req() req: Request, @Res() res: Response) {
    // Flip to not-ready as soon as shutdown starts, before probing anything, so
    // load balancers stop routing new traffic during the drain.
    if (this.shutdown?.isShuttingDown) {
      return sendProbe(
        req,
        res,
        HttpStatus.SERVICE_UNAVAILABLE,
        shuttingDown(['database', 'cache', 'queue', 'soroban']),
      );
    }

    const report = await this.readinessRunner.run(this.readinessChecks);

    // `services` (keyed by name) predates `checks` and stays for existing clients.
    const services: Record<string, DependencyProbeDto> = {};
    for (const check of report.checks) {
      services[check.name] = {
        status: check.status,
        latencyMs: check.latencyMs,
        timestamp: check.timestamp,
        ...(check.error ? { error: check.error } : {}),
      };
    }

    const isReady = report.status === 'up';
    const data: ReadinessDto = {
      status: report.status,
      timestamp: new Date().toISOString(),
      checks: report.checks.map(({ name, status, latencyMs, error }) => ({
        name,
        status,
        latencyMs,
        ...(error ? { error } : {}),
      })),
      services: services as unknown as ReadinessDto['services'],
    };
    return sendProbe(req, res, isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE, data);
  }

  @Get('liveness')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Application liveness check' })
  @ApiResponse({ status: 200, description: 'Application is alive', type: HealthStatusDto })
  getLiveness() {
    return {
      status: 'up',
      timestamp: new Date().toISOString(),
    };
  }

  // Served only as `readiness`: `GET /health/ready` is the orchestrator probe above,
  // and registering `ready` here as well put a second, unreachable handler on that
  // route whose richer schema the OpenAPI document then showed in its place.
  @Get('readiness')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Application readiness check' })
  @ApiResponse({ status: 200, description: 'Application is ready', type: HealthStatusDto })
  @ApiResponse({
    status: 503,
    description: 'Application is not ready',
    type: HealthStatusDto,
  })
  async getReadiness(@Res() res: Response) {
    if (this.shutdown?.isShuttingDown) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json(shuttingDown(['database', 'redis', 'stellar', 'migrations']));
    }

    // The database indicator is a Terminus health indicator, so it reports
    // `{ database: { status, ...details } }`; unwrap it to the same flat shape
    // the other dependencies use.
    const [database, redisHealth, stellarHealth, migrationHealth] = await Promise.all([
      this.dbIndicator.check('database'),
      this.redisIndicator.checkHealth(),
      this.stellarIndicator.checkHealth(),
      this.migrationIndicator.checkHealth(),
    ]);

    const services = {
      database: unwrap(database, 'database'),
      redis: redisHealth,
      stellar: stellarHealth,
      migrations: migrationHealth,
    };

    const isHealthy = Object.values(services).every((s) => s.status === 'up');
    const statusCode = isHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json({
      status: isHealthy ? 'up' : 'down',
      timestamp: new Date().toISOString(),
      services,
    });
  }

  @Get('database')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Database connectivity check' })
  @ApiResponse({ status: 200, description: 'Database is reachable', type: HealthStatusDto })
  @ApiResponse({
    status: 503,
    description: 'Database is unreachable',
    type: HealthStatusDto,
  })
  async getDatabase(@Res() res: Response) {
    const database = unwrap(await this.dbIndicator.check('database'), 'database');

    const isUp = database.status === 'up';
    const statusCode = isUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json(database);
  }

  @Get('redis')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Redis connectivity check' })
  @ApiResponse({ status: 200, description: 'Redis is reachable', type: HealthStatusDto })
  @ApiResponse({
    status: 503,
    description: 'Redis is unreachable',
    type: HealthStatusDto,
  })
  async getRedis(@Res() res: Response) {
    const redis = await this.redisIndicator.checkHealth();

    const isUp = redis.status === 'up';
    const statusCode = isUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json(redis);
  }

  @Get('stellar')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Stellar network connectivity check',
    description:
      'Probes the configured Horizon server and Soroban RPC node in parallel, each bounded ' +
      'by a timeout. Returns 200 when both endpoints are healthy and 503 when one of them ' +
      'is down or degraded.',
  })
  @ApiResponse({ status: 200, description: 'Horizon and Soroban RPC are reachable', type: StellarHealthDto })
  @ApiResponse({
    status: 503,
    description: 'Horizon or the Soroban RPC is unreachable or degraded',
    type: StellarHealthDto,
  })
  async getStellar(@Res() res: Response) {
    const stellar = await this.stellarIndicator.checkHealth();

    // A degraded endpoint is not healthy: monitoring must be able to tell the
    // difference between "reachable" and "usable", so only `up` answers 200.
    const isUp = stellar.status === 'up';
    const statusCode = isUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json(stellar);
  }

  @Get()
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Application health check' })
  @ApiResponse({ status: 200, description: 'Application is healthy', type: HealthStatusDto })
  @ApiResponse({
    status: 503,
    description: 'Application is degraded or unhealthy',
    type: HealthStatusDto,
  })
  async check(@Res() res: Response) {
    return this.getReadiness(res);
  }
}

/**
 * Readiness payload while the process is shutting down: every dependency is
 * reported `down` because no new work is accepted, and `reason` names the cause
 * so an operator is not left guessing which probe failed.
 */
function shuttingDown(dependencies: readonly string[]) {
  const timestamp = new Date().toISOString();
  const service = { status: 'down', latencyMs: 0, timestamp, error: 'unavailable' } as const;
  return {
    status: 'down' as const,
    timestamp,
    reason: 'shutting_down' as const,
    services: Object.fromEntries(dependencies.map((name) => [name, { ...service }])),
  };
}

/**
 * Flattens a Terminus `HealthIndicatorResult` entry keyed by `key` into the flat
 * per-dependency report the readiness payload uses. Terminus exposes the failure
 * detail as a free-form `message`; the payload has always exposed a single
 * `error` string, so the two are reconciled here.
 */
function unwrap(result: HealthIndicatorResult, key: string): ReadinessServiceReport {
  const entry = result[key] as
    | { status: 'up' | 'down'; timestamp?: string; error?: string; message?: string }
    | undefined;

  if (!entry) {
    return {
      status: 'down',
      timestamp: new Date().toISOString(),
      error: 'Health indicator returned no result',
    };
  }

  const { message, error, ...details } = entry;
  return {
    ...details,
    status: entry.status,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    ...(message ?? error ? { error: message ?? error } : {}),
  };
}

/**
 * Writes a probe answer in the standard envelope. The probes reply through `@Res()`
 * because readiness must set 503 itself, which also bypasses the global
 * `ResponseInterceptor`; the envelope is built here with the same request id
 * resolution that interceptor uses.
 */
function sendProbe<T>(req: Request, res: Response, status: HttpStatus, data: T) {
  const header = req.headers?.[REQUEST_ID_HEADER];
  const body: ProbeEnvelope<T> = {
    success: status < HttpStatus.BAD_REQUEST,
    data,
    meta: {},
    requestId: (Array.isArray(header) ? header[0] : header) ?? 'unknown',
  };
  return res.status(status).json(body);
}
