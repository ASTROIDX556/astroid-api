import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { DatabaseConnectionHealthIndicator } from './indicators/database-connection.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly dbConnectionHealth: DatabaseConnectionHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
    private readonly stellarHealth: StellarHealthIndicator,
    private readonly migrationHealth: DatabaseMigrationHealthIndicator,
  ) {}

  @Public()
  @Get('liveness')
  getLiveness() {
    return {
      status: 'up',
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get(['', 'readiness'])
  async getReadiness(@Res() res: Response) {
    const [database, redis, stellar, migrations] = await Promise.all([
      this.dbConnectionHealth.checkHealth(),
      this.redisHealth.checkHealth(),
      this.stellarHealth.checkHealth().catch((err: unknown) => ({
        status: 'down' as const,
        timestamp: new Date().toISOString(),
        network: 'unknown',
        horizon: {
          status: 'down' as const,
          latencyMs: 0,
          url: '',
          error: err instanceof Error ? err.message : String(err),
        },
        sorobanRpc: {
          status: 'down' as const,
          latencyMs: 0,
          url: '',
          error: err instanceof Error ? err.message : String(err),
        },
      })),
      this.migrationHealth.isEnabled
        ? await this.migrationHealth.checkHealth().catch((err: unknown) => ({
            status: 'down' as const,
            timestamp: new Date().toISOString(),
            pendingMigrations: 0,
            lastMigrationName: null,
            lastMigrationApplied: null,
            error: err instanceof Error ? err.message : String(err),
          }))
        : null,
    ]);

    const isDatabaseDown = database.status === 'down';
    const isRedisDown = redis.status === 'down';
    const isStellarDown = stellar.status === 'down';
    const isMigrationsDown = migrations?.status === 'down';

    const isUnhealthy = isDatabaseDown || isRedisDown || isStellarDown || isMigrationsDown;
    const isDegraded =
      !isUnhealthy && (stellar.status === 'degraded' || migrations?.status === 'degraded');

    const overallStatus = isUnhealthy ? 'down' : isDegraded ? 'degraded' : 'up';

    const responsePayload = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      services: {
        database,
        redis,
        stellar,
        ...(migrations ? { migrations } : {}),
      },
    };

    if (isUnhealthy) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json(responsePayload);
    }

    return res.status(HttpStatus.OK).json(responsePayload);
  }
}
