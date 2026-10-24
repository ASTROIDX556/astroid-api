import { describe, expect, it, vi } from 'vitest';
import { RiskBand } from '@prisma/client';
import { RiskAnalysisWorker } from './risk-analysis.worker';
import { RiskService } from '../risk.service';
import { RiskRepository } from '../risk.repository';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import type { Job } from 'bullmq';
import type { RiskAnalysisJob } from './risk-analysis.worker';

const factors = {
  amount: 100,
  asset: 'XLM',
  knownRecipient: true,
  recentTransactionCount: 2,
  walletAgeDays: 100,
  policyViolations: 0,
};

function setup(band: RiskBand) {
  const assessment = { score: band === RiskBand.CRITICAL ? 81 : 80, band, factors: [], canAutoExecute: band !== RiskBand.CRITICAL };
  const evaluate = vi.fn().mockResolvedValue(assessment);
  const emit = vi.fn().mockResolvedValue(undefined);
  const baseline = vi.fn().mockResolvedValue({ knownRecipient: true, recentTransactionCount: 2, baselineTransactionCount: 1, baselineAmount: 10 });
  const enforceRiskControls = vi.fn().mockResolvedValue(undefined);
  const worker = new RiskAnalysisWorker(
    { evaluate } as unknown as RiskService,
    { emit } as unknown as EventBusService,
    { getTransactionBaseline: baseline, enforceRiskControls } as unknown as RiskRepository,
  );
  const job = { data: { organizationId: 'org', transactionId: 'tx', factors } } as Job<RiskAnalysisJob>;
  return { worker, job, evaluate, emit, enforceRiskControls };
}

describe('RiskAnalysisWorker', () => {
  it('evaluates jobs and does not alert below high risk', async () => {
    const { worker, job, evaluate, emit } = setup(RiskBand.MEDIUM);
    await worker.process(job);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([RiskBand.HIGH, RiskBand.CRITICAL])('alerts on %s', async (band) => {
    const { worker, job, emit, enforceRiskControls } = setup(band);
    await worker.process(job);
    expect(enforceRiskControls).toHaveBeenCalledWith('org', 'tx', band === RiskBand.CRITICAL);
    expect(emit).toHaveBeenCalledWith(
      DomainEventName.RiskAlert,
      expect.objectContaining({ transactionId: 'tx', riskLevel: band }),
      expect.objectContaining({ organizationId: 'org' }),
    );
  });

  it('uses historical velocity and amount baselines', async () => {
    const { worker, job, evaluate } = setup(RiskBand.LOW);
    job.data.baselineTransactionCount = 1;
    job.data.baselineAmount = 10;
    await worker.process(job);
    expect(evaluate).toHaveBeenCalledWith('org', expect.objectContaining({
      recentTransactionCount: 10,
      amount: 10000,
    }), { transactionId: 'tx', actorId: undefined });
  });

  it('rejects invalid job payloads', async () => {
    const { worker, job } = setup(RiskBand.LOW);
    job.data.factors.amount = -1;
    await expect(worker.process(job)).rejects.toThrow('Invalid risk analysis job');
  });
});
