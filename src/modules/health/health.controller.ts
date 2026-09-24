import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
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
    private readonly dbIndicator: DatabaseConnectionHealthIndicator,
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
    const [dbHealth, redisHealth, stellarHealth, migrationHealth] = await Promise.all([
      this.dbIndicator.checkHealth(),
      this.redisIndicator.checkHealth(),
      this.stellarIndicator.checkHealth(),
      this.migrationIndicator.checkHealth(),
    ]);

    const services = {
      database: dbHealth,
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

  @Get()
  @ApiOperation({ summary: 'Application health check' })
  @ApiResponse({ status: 200, description: 'Application is healthy' })
  @ApiResponse({ status: 503, description: 'Application is degraded or unhealthy' })
  async check(@Res() res: Response) {
    return this.getReadiness(res);
  }
}
