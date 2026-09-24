import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { DatabaseConnectionHealthIndicator } from './indicators/database-connection.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly dbHealth: DatabaseConnectionHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
    private readonly stellarHealth: StellarHealthIndicator,
    private readonly migrationHealth: DatabaseMigrationHealthIndicator,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check overall system health', description: 'Returns liveness status of the API and its dependencies' })
  @ApiResponse({ status: 200, description: 'System is healthy' })
  @ApiResponse({ status: 503, description: 'System is degraded or unhealthy' })
  async check(@Res() res: Response) {
    return this.getReadiness(res);
  }

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe', description: 'Basic liveness check for container orchestration' })
  @ApiResponse({ status: 200, description: 'Application is alive' })
  live() {
    return this.getLiveness();
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness probe', description: 'Readiness check verifying database and Redis connectivity' })
  @ApiResponse({ status: 200, description: 'Application is ready' })
  @ApiResponse({ status: 503, description: 'Application is not ready' })
  async ready(@Res() res: Response) {
    return this.getReadiness(res);
  }

  getLiveness() {
    return { status: 'up', timestamp: new Date().toISOString() };
  }

  async getReadiness(@Res() res: Response) {
    const db = await this.dbHealth.checkHealth();
    const redis = await this.redisHealth.checkHealth();
    const stellar = await this.stellarHealth.checkHealth();
    const migrations = await this.migrationHealth.checkHealth();

    const isHealthy = db.status === 'up' && redis.status === 'up' && stellar.status === 'up' && migrations.status === 'up';
    const status = isHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(status).json({
      status: isHealthy ? 'up' : 'down',
      timestamp: new Date().toISOString(),
      services: {
        database: db,
        redis,
        stellar,
        migrations,
      },
    });
  }
}
