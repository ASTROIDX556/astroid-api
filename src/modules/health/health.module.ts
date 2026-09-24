import { Module } from '@nestjs/common';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { HealthController } from './health.controller';
import { DatabaseModule } from '../../database/database.module';
import { redisConfig } from '../../config/redis.config';
import Redis from 'ioredis';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [
    StellarHealthIndicator,
    DatabaseMigrationHealthIndicator,
    DatabaseHealthIndicator,
    RedisHealthIndicator,
    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        const { host, port, password, db } = redisConfig();
        return new Redis({
          host,
          port,
          password: password || undefined,
          db,
          lazyConnect: true,
        });
      },
    },
  ],
  exports: [
    StellarHealthIndicator,
    DatabaseMigrationHealthIndicator,
    DatabaseHealthIndicator,
    RedisHealthIndicator,
  ],
})
export class HealthModule {}
