import { Injectable, Logger } from '@nestjs/common';
import { RiskEngine } from './risk.engine';
import { RiskRepository } from './risk.repository';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import {
  RiskAggregation,
  RiskAggregationInput,
  RiskAssessment,
  RiskConfig,
  RiskFactorsInput,
  RiskSignals,
} from './risk.types';

/** Default trailing window used for the velocity signal. */
const DEFAULT_VELOCITY_WINDOW_HOURS = 24;
/** Default trailing window used for the amount baseline. */
const DEFAULT_AMOUNT_BASELINE_WINDOW_DAYS = 90;

/**
 * Risk aggregator for incoming agent transactions.
 *
 * The aggregator turns the raw transaction history into three signals —
 * velocity (how much the wallet has moved recently), destination reputation
 * (how reliable the destination has been for this organization) and amount
 * anomaly (how far the amount strays from the wallet's own average) — and
 * combines them with the remaining risk rules into a single composite score
 * between 0 and 100.
 *
 * Responsibilities are deliberately split:
 *  - {@link assess} gathers the signals and scores them; it never writes.
 *  - {@link record} persists the assessment against the transaction and emits
 *    the domain events the downstream notification workers consume.
 *
 * The transaction pipeline calls `assess` before the transaction row exists
 * (the score decides whether a human approval is required) and `record` right
 * after the row was created (the assessment is linked to the transaction).
 */
@Injectable()
export class RiskAggregatorService {
  private readonly logger = new Logger(RiskAggregatorService.name);

  constructor(
    private readonly engine: RiskEngine,
    private readonly repository: RiskRepository,
    private readonly eventBus: EventBusService,
  ) {}

  /**
   * Gathers the risk signals for a transaction and returns the composite
   * assessment. The signal queries run in parallel so the extra round trips do
   * not add up.
   */
  async assess(
    input: RiskAggregationInput,
    config?: Partial<RiskConfig>,
  ): Promise<RiskAggregation> {
    const signals = await this.gatherSignals(input);

    const factors: RiskFactorsInput = {
      amount: input.amount,
      asset: input.asset,
      knownRecipient: signals.destinationSuccessfulPayments > 0,
      recentTransactionCount: signals.recentTransactionCount,
      walletAgeDays: input.walletAgeDays,
      policyViolations: input.policyViolations ?? 0,
      hourUtc: input.hourUtc,
      recentTransactionAmount: signals.recentTransactionAmount,
      destinationPaymentCount:
        signals.destinationSuccessfulPayments + signals.destinationFailedPayments,
      destinationFailureCount: signals.destinationFailedPayments,
      amountBaseline: signals.amountBaseline ?? undefined,
    };

    const assessment = this.engine.assess(factors, config);

    return {
      ...assessment,
      signals,
    };
  }

  /**
   * Persists the assessment against the transaction and emits the risk
   * evaluation events. High-risk assessments additionally raise a risk alert
   * so the notification workers can inform the organization.
   */
  async record(
    organizationId: string,
    transactionId: string,
    assessment: RiskAssessment,
    context: { actorId?: string } = {},
  ): Promise<void> {
    await this.repository.createAssessmentRecord({
      organizationId,
      transactionId,
      score: assessment.score,
      band: assessment.band,
      factors: { factors: assessment.factors },
      canAutoExecute: assessment.canAutoExecute,
    });

    await this.eventBus.emit(
      DomainEventName.RiskEvaluated,
      {
        transactionId,
        score: assessment.score,
        band: assessment.band,
        factors: assessment.factors,
        canAutoExecute: assessment.canAutoExecute,
        requiresApproval: assessment.requiresApproval,
      },
      {
        organizationId,
        actorId: context.actorId,
        aggregateType: 'transaction',
        aggregateId: transactionId,
      },
    );

    if (!assessment.requiresApproval) {
      return;
    }

    this.logger.warn(
      `Transaction ${transactionId} scored ${assessment.score} (${assessment.band}) and requires human review.`,
    );
    await this.eventBus.emit(
      DomainEventName.RiskAlert,
      {
        transactionId,
        score: assessment.score,
        band: assessment.band,
        riskLevel: assessment.band,
        requiresApproval: true,
      },
      {
        organizationId,
        actorId: context.actorId,
        aggregateType: 'transaction',
        aggregateId: transactionId,
      },
    );
  }

  /** Collects the raw signals the composite score is derived from. */
  private async gatherSignals(input: RiskAggregationInput): Promise<RiskSignals> {
    const velocityWindowHours =
      input.velocityWindowHours ?? DEFAULT_VELOCITY_WINDOW_HOURS;
    const amountBaselineWindowDays =
      input.amountBaselineWindowDays ?? DEFAULT_AMOUNT_BASELINE_WINDOW_DAYS;

    const [velocity, destination, amountBaseline] = await Promise.all([
      this.repository.getWalletVelocity(input.walletId, velocityWindowHours),
      this.repository.getDestinationHistory(input.organizationId, input.recipientAddress),
      this.repository.getAmountBaseline(input.walletId, amountBaselineWindowDays),
    ]);

    return {
      recentTransactionCount: velocity.count,
      recentTransactionAmount: velocity.totalAmount,
      destinationSuccessfulPayments: destination.successful,
      destinationFailedPayments: destination.failed,
      amountBaseline,
    };
  }
}
