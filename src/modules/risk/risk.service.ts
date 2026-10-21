import { Injectable } from '@nestjs/common';
import { RiskEngine } from './risk.engine';
import { RiskAssessment, RiskConfig, RiskFactorsInput, RiskRule } from './risk.types';
import { RiskRepository } from './risk.repository';

/**
 * Read-only facade over the risk engine and the stored assessments.
 *
 * The transaction pipeline uses {@link RiskAggregatorService}, which owns the
 * signal gathering, the persistence and the event emission for incoming agent
 * transactions. This service stays synchronous and side-effect free so it can
 * serve ad-hoc assessments (POST /risk/assess) and the compliance reporting
 * endpoints.
 */
@Injectable()
export class RiskService {
  constructor(
    private readonly engine: RiskEngine,
    private readonly repository: RiskRepository,
  ) {}

  /** Synchronous assessment without event emission or persistence. */
  assess(
    input: RiskFactorsInput,
    config?: Partial<RiskConfig>,
    rules?: RiskRule[],
  ): RiskAssessment {
    return this.engine.assess(input, config, rules);
  }

  async getHistory(organizationId: string, limit = 100) {
    return this.repository.findByOrganization(organizationId, limit);
  }

  async getStatistics(organizationId: string, days = 30) {
    return this.repository.getStatistics(organizationId, days);
  }
}
