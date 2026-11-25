import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { QueueHealthIndicator } from './indicators/queue.health';
import { QueueModule } from '../../queues/queue.module';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { DatabaseMigrationHealthIndicator } from './indicators/database-migration.health';
import { DatabaseModule } from '../../database/database.module';

@Module({
  // TerminusModule supplies `HealthCheckService` and the indicator base class
  // used by PrismaHealthIndicator.
  imports: [DatabaseModule, TerminusModule, QueueModule],
  controllers: [HealthController],
  providers: [
    PrismaHealthIndicator,
    RedisHealthIndicator,
    QueueHealthIndicator,
    StellarHealthIndicator,
    DatabaseMigrationHealthIndicator,
  ],
  exports: [
    PrismaHealthIndicator,
    RedisHealthIndicator,
    QueueHealthIndicator,
    StellarHealthIndicator,
    DatabaseMigrationHealthIndicator,
  ],
})
export class HealthModule {}
