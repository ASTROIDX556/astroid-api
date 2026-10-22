import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Queues } from '../../../queues/queues.constants';
import { RiskService } from '../risk.service';
import type { RiskFactorsInput } from '../risk.types';

export interface RiskAnalysisJob {
  organizationId: string;
  transactionId: string;
  factors: RiskFactorsInput;
}

@Injectable()
@Processor(Queues.RiskAnalysis)
export class RiskAnalysisWorker extends WorkerHost {
  constructor(private readonly riskService: RiskService) { super(); }

  async process(job: Job<RiskAnalysisJob>) {
    const { organizationId, transactionId, factors } = job.data;
    return this.riskService.evaluate(organizationId, factors, { transactionId });
  }
}
