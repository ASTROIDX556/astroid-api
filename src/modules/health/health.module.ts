import { Module } from '@nestjs/common';
import { StellarHealthIndicator } from './indicators/stellar.health';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [StellarHealthIndicator],
  exports: [StellarHealthIndicator],
})
export class HealthModule {}
