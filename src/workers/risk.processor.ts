import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Queues } from '../queues/queues.constants';
import { RiskService } from '../modules/risk/risk.service';
import { RiskAnalysisJobData } from '../modules/risk/risk.types';
import { runWorkerJob } from './job-worker';

@Injectable()
@Processor(Queues.RiskAnalysis)
export class RiskProcessor extends WorkerHost {
  private readonly logger = new Logger(RiskProcessor.name);

  constructor(private readonly riskService: RiskService) {
    super();
  }

  async process(job: Job<RiskAnalysisJobData>) {
    return runWorkerJob({
      queue: Queues.RiskAnalysis,
      job,
      logger: this.logger,
      defaultJobName: 'risk-evaluation',
      handler: () => this.riskService.evaluateQueuedTransaction(job.data),
    });
  }
}