import { Module } from '@nestjs/common';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';
import { RiskAggregatorService } from './risk-aggregator.service';
import { RiskEngine } from './risk.engine';
import { RiskRepository } from './risk.repository';
import { DatabaseModule } from '../../database/database.module';
import { BullModule } from '@nestjs/bullmq';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue(createQueueRegistrationOptions(Queues.RiskAnalysis)),
  ],
  controllers: [RiskController],
  providers: [RiskService, RiskAggregatorService, RiskEngine, RiskRepository],
  exports: [RiskService, RiskAggregatorService, RiskEngine, RiskRepository],
})
export class RiskModule {}
