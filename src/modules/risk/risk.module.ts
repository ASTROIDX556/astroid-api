import { Module } from '@nestjs/common';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';
import { RiskEngine } from './risk.engine';
import { RiskRepository } from './risk.repository';
import { RiskAnalysisWorker } from './workers/risk-analysis.worker';
import { DatabaseModule } from '../../database/database.module';
import { BullModule } from '@nestjs/bullmq';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';
import { RiskProcessor } from '../../workers/risk.processor';

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue(createQueueRegistrationOptions(Queues.RiskAnalysis)),
  ],
  controllers: [RiskController],
  providers: [RiskService, RiskEngine, RiskRepository, RiskAnalysisWorker],
  exports: [RiskService, RiskEngine, RiskRepository],
})
export class RiskModule {}
