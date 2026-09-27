import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HealthIndicatorResult } from '@nestjs/terminus';
import { Response } from 'express';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';

/** Per-dependency report shape returned under `services` in the readiness body. */
interface ReadinessServiceReport {
  status: string;
  timestamp: string;
  [key: string]: unknown;
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly dbIndicator: PrismaHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly stellarIndicator: StellarHealthIndicator,
    private readonly migrationIndicator: DatabaseMigrationHealthIndicator,
  ) {}

  @Get('liveness')
  @ApiOperation({ summary: 'Application liveness check' })
  @ApiResponse({ status: 200, description: 'Application is alive' })
  getLiveness() {
    return {
      status: 'up',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Application readiness check' })
  @ApiResponse({ status: 200, description: 'Application is ready' })
  @ApiResponse({ status: 503, description: 'Application is not ready' })
  async getReadiness(@Res() res: Response) {
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
  @ApiOperation({ summary: 'Database connectivity check' })
  @ApiResponse({ status: 200, description: 'Database is reachable' })
  @ApiResponse({ status: 503, description: 'Database is unreachable' })
  async getDatabase(@Res() res: Response) {
    const database = unwrap(await this.dbIndicator.check('database'), 'database');

    const isUp = database.status === 'up';
    const statusCode = isUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json(database);
  }

  @Get()
  @ApiOperation({ summary: 'Application health check' })
  @ApiResponse({ status: 200, description: 'Application is healthy' })
  @ApiResponse({ status: 503, description: 'Application is degraded or unhealthy' })
  async check(@Res() res: Response) {
    return this.getReadiness(res);
  }
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
