import { describe, expect, it, beforeEach, vi } from 'vitest';
import { RiskBand } from '@prisma/client';
import { RiskAggregatorService } from './risk-aggregator.service';
import { RiskEngine } from './risk.engine';
import { RiskRepository } from './risk.repository';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { RiskAggregationInput } from './risk.types';

const baseInput: RiskAggregationInput = {
  organizationId: 'org-1',
  walletId: 'wallet-1',
  recipientAddress: 'GDESTINATIONADDRESS0000000000000000000000000000000',
  amount: 100,
  asset: 'USDC',
  walletAgeDays: 365,
  policyViolations: 0,
  hourUtc: 12,
};

describe('RiskAggregatorService', () => {
  let repository: {
    getWalletVelocity: ReturnType<typeof vi.fn>;
    getDestinationHistory: ReturnType<typeof vi.fn>;
    getAmountBaseline: ReturnType<typeof vi.fn>;
    createAssessmentRecord: ReturnType<typeof vi.fn>;
  };
  let eventBus: { emit: ReturnType<typeof vi.fn> };

  const createService = () =>
    new RiskAggregatorService(
      new RiskEngine(),
      repository as unknown as RiskRepository,
      eventBus as unknown as EventBusService,
    );

  beforeEach(() => {
    repository = {
      getWalletVelocity: vi.fn().mockResolvedValue({ count: 0, totalAmount: 0 }),
      getDestinationHistory: vi.fn().mockResolvedValue({ successful: 0, failed: 0 }),
      getAmountBaseline: vi.fn().mockResolvedValue(null),
      createAssessmentRecord: vi.fn().mockResolvedValue({ id: 'assessment-1' }),
    };
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
  });

  // ── Signal gathering ─────────────────────────────────────────────────────

  it('gathers the velocity, reputation and anomaly signals', async () => {
    repository.getWalletVelocity.mockResolvedValue({ count: 4, totalAmount: 900 });
    repository.getDestinationHistory.mockResolvedValue({ successful: 3, failed: 1 });
    repository.getAmountBaseline.mockResolvedValue(250);

    const result = await createService().assess(baseInput);

    expect(repository.getWalletVelocity).toHaveBeenCalledWith('wallet-1', 24);
    expect(repository.getDestinationHistory).toHaveBeenCalledWith(
      'org-1',
      baseInput.recipientAddress,
    );
    expect(repository.getAmountBaseline).toHaveBeenCalledWith('wallet-1', 90);
    expect(result.signals).toEqual({
      recentTransactionCount: 4,
      recentTransactionAmount: 900,
      destinationSuccessfulPayments: 3,
      destinationFailedPayments: 1,
      amountBaseline: 250,
    });
  });

  it('honours custom signal windows', async () => {
    await createService().assess({
      ...baseInput,
      velocityWindowHours: 6,
      amountBaselineWindowDays: 30,
    });

    expect(repository.getWalletVelocity).toHaveBeenCalledWith('wallet-1', 6);
    expect(repository.getAmountBaseline).toHaveBeenCalledWith('wallet-1', 30);
  });

  // ── Composite scoring ────────────────────────────────────────────────────

  it('scores a quiet transaction to a new destination below the review threshold', async () => {
    const result = await createService().assess(baseInput);

    // Only the "never paid this destination before" signal contributes.
    expect(result.score).toBe(15);
    expect(result.band).toBe(RiskBand.LOW);
    expect(result.requiresApproval).toBe(false);
    expect(result.canAutoExecute).toBe(true);
  });

  it('raises the score when the wallet moves a lot of value in a short window', async () => {
    repository.getWalletVelocity.mockResolvedValue({ count: 20, totalAmount: 0 });

    const result = await createService().assess(baseInput);

    const velocity = result.factors.find((factor) => factor.factor === 'velocity');
    expect(velocity?.contribution).toBe(20);
    expect(result.score).toBeGreaterThan(15);
  });

  it('raises the score when the wallet moves more value than the count suggests', async () => {
    repository.getWalletVelocity.mockResolvedValue({ count: 1, totalAmount: 20_000 });

    const result = await createService().assess(baseInput);

    const velocity = result.factors.find((factor) => factor.factor === 'velocity');
    expect(velocity?.contribution).toBe(20);
  });

  it('raises the score for a destination with a poor payment history', async () => {
    repository.getDestinationHistory.mockResolvedValue({ successful: 5, failed: 5 });

    const result = await createService().assess(baseInput);

    const reputation = result.factors.find((factor) => factor.factor === 'destinationReputation');
    // 50% failures, full history → half of the reputation weight.
    expect(reputation?.contribution).toBeCloseTo(2.5, 5);
  });

  it('raises the score for a destination with only a shallow payment history', async () => {
    repository.getDestinationHistory.mockResolvedValue({ successful: 1, failed: 0 });

    const result = await createService().assess(baseInput);

    const reputation = result.factors.find((factor) => factor.factor === 'destinationReputation');
    // 1 of 5 payments known → shallow history, no failures.
    expect(reputation?.contribution).toBeCloseTo(4, 5);
  });

  it('raises the score for an amount far above the wallet average', async () => {
    repository.getAmountBaseline.mockResolvedValue(100);

    const result = await createService().assess({ ...baseInput, amount: 500 });

    const anomaly = result.factors.find((factor) => factor.factor === 'amountAnomaly');
    // 5x the average saturates the signal.
    expect(anomaly?.contribution).toBe(10);
  });

  it('does not flag an amount below the wallet average', async () => {
    repository.getAmountBaseline.mockResolvedValue(1_000);

    const result = await createService().assess({ ...baseInput, amount: 500 });

    const anomaly = result.factors.find((factor) => factor.factor === 'amountAnomaly');
    expect(anomaly?.contribution).toBe(0);
  });

  it('does not score an anomaly without a historical baseline', async () => {
    repository.getAmountBaseline.mockResolvedValue(null);

    const result = await createService().assess({ ...baseInput, amount: 500_000 });

    const anomaly = result.factors.find((factor) => factor.factor === 'amountAnomaly');
    expect(anomaly?.contribution).toBe(0);
  });

  it('never produces a score outside the 0-100 range', async () => {
    repository.getWalletVelocity.mockResolvedValue({ count: 999, totalAmount: 10_000_000 });
    repository.getDestinationHistory.mockResolvedValue({ successful: 1, failed: 99 });
    repository.getAmountBaseline.mockResolvedValue(1);

    const result = await createService().assess({ ...baseInput, amount: 10_000_000 });

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.requiresApproval).toBe(true);
  });

  // ── Thresholds ───────────────────────────────────────────────────────────

  it('routes a transaction at the review threshold to human review', async () => {
    const service = createService();
    const baseline = await service.assess(baseInput);

    const atThreshold = await service.assess(baseInput, {
      reviewThreshold: baseline.score,
    });
    const aboveThreshold = await service.assess(baseInput, {
      reviewThreshold: baseline.score - 1,
    });
    const belowThreshold = await service.assess(baseInput, {
      reviewThreshold: baseline.score + 1,
    });

    expect(atThreshold.requiresApproval).toBe(true);
    expect(aboveThreshold.requiresApproval).toBe(true);
    expect(belowThreshold.requiresApproval).toBe(false);
  });

  it('blocks auto-execution at the block threshold', async () => {
    const service = createService();
    const baseline = await service.assess(baseInput);

    const atThreshold = await service.assess(baseInput, {
      blockThreshold: baseline.score,
    });
    const aboveThreshold = await service.assess(baseInput, {
      blockThreshold: baseline.score - 1,
    });
    const belowThreshold = await service.assess(baseInput, {
      blockThreshold: baseline.score + 1,
    });

    expect(atThreshold.canAutoExecute).toBe(false);
    expect(aboveThreshold.canAutoExecute).toBe(false);
    expect(belowThreshold.canAutoExecute).toBe(true);
  });

  it('routes a high risk transaction to human review by default', async () => {
    repository.getWalletVelocity.mockResolvedValue({ count: 20, totalAmount: 20_000 });
    repository.getDestinationHistory.mockResolvedValue({ successful: 1, failed: 1 });
    repository.getAmountBaseline.mockResolvedValue(100);

    const result = await createService().assess({ ...baseInput, amount: 5_000 });

    expect(result.score).toBeGreaterThanOrEqual(51);
    expect(result.requiresApproval).toBe(true);
  });

  // ── Persistence and events ───────────────────────────────────────────────

  it('persists the assessment against the transaction', async () => {
    const service = createService();
    const assessment = await service.assess(baseInput);

    await service.record('org-1', 'tx-1', assessment, { actorId: 'agent-1' });

    expect(repository.createAssessmentRecord).toHaveBeenCalledWith({
      organizationId: 'org-1',
      transactionId: 'tx-1',
      score: assessment.score,
      band: assessment.band,
      factors: { factors: assessment.factors },
      canAutoExecute: assessment.canAutoExecute,
    });
  });

  it('emits the risk evaluation event', async () => {
    const service = createService();
    const assessment = await service.assess(baseInput);

    await service.record('org-1', 'tx-1', assessment, { actorId: 'agent-1' });

    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.RiskEvaluated,
      expect.objectContaining({
        transactionId: 'tx-1',
        score: assessment.score,
        band: assessment.band,
        canAutoExecute: true,
        requiresApproval: false,
      }),
      {
        organizationId: 'org-1',
        actorId: 'agent-1',
        aggregateType: 'transaction',
        aggregateId: 'tx-1',
      },
    );
  });

  it('raises a risk alert for a transaction that needs human review', async () => {
    const service = createService();
    const assessment = await service.assess(baseInput, { reviewThreshold: 1 });

    await service.record('org-1', 'tx-1', assessment);

    expect(eventBus.emit).toHaveBeenCalledTimes(2);
    expect(eventBus.emit).toHaveBeenLastCalledWith(
      DomainEventName.RiskAlert,
      expect.objectContaining({
        transactionId: 'tx-1',
        score: assessment.score,
        band: assessment.band,
        requiresApproval: true,
      }),
      expect.objectContaining({ aggregateId: 'tx-1' }),
    );
  });

  it('does not raise a risk alert for a low risk transaction', async () => {
    const service = createService();
    const assessment = await service.assess(baseInput);

    await service.record('org-1', 'tx-1', assessment);

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith(
      DomainEventName.RiskEvaluated,
      expect.anything(),
      expect.anything(),
    );
  });
});
