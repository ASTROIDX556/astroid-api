import { Injectable } from '@nestjs/common';
import { RiskEngine } from './risk.engine';
import { RiskAssessment, RiskConfig, RiskFactorsInput, RiskRule } from './risk.types';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { RiskRepository } from './risk.repository';

/**
 * Application-facing risk service. Wraps the pure {@link RiskEngine}, emits a
 * RiskEvaluated domain event (with full factor breakdown for audit metadata),
 * persists assessment records for compliance, and is called by the transactions pipeline.
 */
@Injectable()
export class RiskService {
  constructor(
    private readonly engine: RiskEngine,
    private readonly eventBus: EventBusService,
    private readonly repository: RiskRepository,
  ) {}

  /**
   * Full evaluation with event emission and persistence. The emitted event payload includes
   * the complete factor breakdown so the audit listener captures it as metadata.
   * Assessment records are persisted for compliance reporting and pattern analysis.
   */
  async evaluate(
    organizationId: string,
    input: RiskFactorsInput,
    context: { transactionId?: string; actorId?: string; config?: Partial<RiskConfig>; rules?: RiskRule[] } = {},
  ): Promise<RiskAssessment> {
    const assessment = this.engine.assess(input, context.config, context.rules);

    await this.eventBus.emit(
      DomainEventName.RiskEvaluated,
      {
        transactionId: context.transactionId,
        score: assessment.score,
        band: assessment.band,
        factors: assessment.factors,
        canAutoExecute: assessment.canAutoExecute,
      },
      {
        organizationId,
        actorId: context.actorId,
        aggregateType: 'transaction',
        aggregateId: context.transactionId,
      },
    );

    if (context.transactionId) {
      await this.repository.createAssessmentRecord({
        organizationId,
        transactionId: context.transactionId,
        score: assessment.score,
        band: assessment.band,
        factors: { factors: assessment.factors },
        canAutoExecute: assessment.canAutoExecute,
      });
    }

    return assessment;
  }

  /** Synchronous assessment without event emission or persistence (used by simulate). */
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
