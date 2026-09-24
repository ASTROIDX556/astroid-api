import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { DatabaseConnectionHealthIndicator } from './indicators/database-connection.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { Public } from '../../common/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(
    private readonly dbHealth: DatabaseConnectionHealthIndicator,
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
  @Get('readiness')
  async getReadiness(@Res() res: Response) {
    const [db, redis, stellar, migration] = await Promise.all([
      this.dbHealth.checkHealth(),
      this.redisHealth.checkHealth(),
      this.stellarHealth.checkHealth(),
      this.migrationHealth.isEnabled
        ? this.migrationHealth.checkHealth()
        : Promise.resolve({ status: 'up', timestamp: new Date().toISOString(), pendingMigrations: 0, lastMigrationName: null, lastMigrationApplied: null }),
    ]);

    const services = {
      database: db,
      redis,
      stellar,
      migrations: migration,
    };

    const allUp = Object.values(services).every((s) => s.status === 'up');
    const status = allUp ? 'up' : 'down';
    const statusCode = allUp ? 200 : 503;

    return res.status(statusCode).json({
      status,
      timestamp: new Date().toISOString(),
      services,
    });
  }
}
