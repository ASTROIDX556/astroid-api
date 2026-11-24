import { Module } from '@nestjs/common';
import { QueueObservabilityController } from './queue-observability.controller';
import { QueueObservabilityService } from './queue-observability.service';

@Module({
  controllers: [QueueObservabilityController],
  providers: [
    QueueObservabilityService,
  ],
  exports: [QueueObservabilityService],
})
export class QueueObservabilityModule {}