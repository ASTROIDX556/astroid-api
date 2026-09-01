import { Module } from '@nestjs/common';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [StellarHealthIndicator, DatabaseMigrationHealthIndicator],
  exports: [StellarHealthIndicator, DatabaseMigrationHealthIndicator],
})
export class HealthModule {}
