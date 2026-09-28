import { Module } from '@nestjs/common';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { BullMQHealthIndicator } from './indicators/bullmq.health';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [StellarHealthIndicator, DatabaseMigrationHealthIndicator, BullMQHealthIndicator],
  exports: [StellarHealthIndicator, DatabaseMigrationHealthIndicator, BullMQHealthIndicator],
})
export class HealthModule {}
