import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseConnectionHealthIndicator } from './indicators/database-connection.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { DatabaseModule } from '../../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [
    DatabaseConnectionHealthIndicator,
    RedisHealthIndicator,
    StellarHealthIndicator,
    DatabaseMigrationHealthIndicator,
  ],
  exports: [
    DatabaseConnectionHealthIndicator,
    RedisHealthIndicator,
    StellarHealthIndicator,
    DatabaseMigrationHealthIndicator,
  ],
})
export class HealthModule {}
