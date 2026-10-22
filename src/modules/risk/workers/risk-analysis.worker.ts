import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { RiskBand } from '@prisma/client';
import type { Job } from 'bullmq';
import { Queues } from '../../../queues/queues.constants';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { RiskService } from '../risk.service';
import { RiskRepository } from '../risk.repository';
import type { RiskFactorsInput } from '../risk.types';

export interface RiskAnalysisJob {
  organizationId: string;
  transactionId: string;
  actorId?: string;
  factors: RiskFactorsInput;
  baselineTransactionCount?: number;
  baselineAmount?: number;
}

@Injectable()
@Processor(Queues.RiskAnalysis)
export class RiskAnalysisWorker extends WorkerHost {
  constructor(
    private readonly riskService: RiskService,
    private readonly events: EventBusService,
    private readonly repository: RiskRepository,
  ) { super(); }

  async process(job: Job<RiskAnalysisJob>) {
    const data = job.data;
    if (!data?.organizationId || !data.transactionId || !data.factors ||
        !Number.isFinite(data.factors.amount) || data.factors.amount < 0) {
      throw new Error('Invalid risk analysis job');
    }
    const history = await this.repository.getTransactionBaseline(data.organizationId, data.transactionId);
    const factors = { ...data.factors, knownRecipient: history.knownRecipient, recentTransactionCount: history.recentTransactionCount };
    const baselineTransactionCount = data.baselineTransactionCount ?? history.baselineTransactionCount;
    const baselineAmount = data.baselineAmount ?? history.baselineAmount;
    if (baselineTransactionCount !== undefined) {
      if (!Number.isFinite(baselineTransactionCount) || baselineTransactionCount < 0) {
        throw new Error('Invalid historical transaction count');
      }
      const ratio = factors.recentTransactionCount / Math.max(1, baselineTransactionCount);
      factors.recentTransactionCount = Math.max(factors.recentTransactionCount, Math.ceil(ratio * 5));
    }
    if (baselineAmount !== undefined) {
      if (!Number.isFinite(baselineAmount) || baselineAmount < 0) {
        throw new Error('Invalid historical transfer amount');
      }
      factors.amount = Math.max(factors.amount, (factors.amount / Math.max(1, baselineAmount)) * 1000);
    }
    const result = await this.riskService.evaluate(data.organizationId, factors, {
      transactionId: data.transactionId,
      actorId: data.actorId,
    });
    if (result.band === RiskBand.HIGH || result.band === RiskBand.CRITICAL) {
      await this.repository.enforceRiskControls(data.organizationId, data.transactionId, result.band === RiskBand.CRITICAL);
      await this.events.emit(DomainEventName.RiskAlert, {
        transactionId: data.transactionId,
        riskLevel: result.band,
      }, {
        organizationId: data.organizationId,
        actorId: data.actorId,
        aggregateType: 'transaction',
        aggregateId: data.transactionId,
      });
    }
    return result;
  }
}
