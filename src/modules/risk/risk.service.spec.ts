import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RiskBand } from '@prisma/client';
import { RiskService } from './risk.service';
import { RiskEngine } from './risk.engine';
import { RiskRepository } from './risk.repository';
import { RiskFactorsInput } from './risk.types';

const lowRisk: RiskFactorsInput = {
  amount: 20,
  asset: 'USDC',
  knownRecipient: true,
  recentTransactionCount: 1,
  walletAgeDays: 365,
  policyViolations: 0,
  hourUtc: 12,
};

describe('RiskService', () => {
  let repository: RiskRepository;

  beforeEach(() => {
    repository = {
      findByOrganization: vi.fn().mockResolvedValue([]),
      findByTransaction: vi.fn().mockResolvedValue(null),
      getStatistics: vi.fn().mockResolvedValue({ total: 0 }),
    } as unknown as RiskRepository;
  });

  const createService = () => new RiskService(new RiskEngine(), repository);

  it('assess() returns a result without touching the repository', () => {
    const service = createService();

    const assessment = service.assess(lowRisk);

    expect(assessment.band).toBe(RiskBand.LOW);
    expect(assessment.requiresApproval).toBe(false);
    expect(repository.findByOrganization).not.toHaveBeenCalled();
  });

  it('passes config overrides through to the engine', () => {
    const service = createService();

    const assessment = service.assess({ ...lowRisk, amount: 100 }, { amountSaturation: 100 });
    const amountFactor = assessment.factors.find((factor) => factor.factor === 'amount');
    expect(amountFactor?.contribution).toBe(30);
  });

  it('flags an assessment above the review threshold', () => {
    const service = createService();

    const assessment = service.assess({
      amount: 50_000,
      asset: 'USDC',
      knownRecipient: false,
      recentTransactionCount: 20,
      walletAgeDays: 0,
      policyViolations: 3,
      hourUtc: 2,
    });

    expect(assessment.requiresApproval).toBe(true);
    expect(assessment.canAutoExecute).toBe(false);
  });

  it('delegates the history and statistics queries to the repository', async () => {
    const service = createService();

    await service.getHistory('org-1', 25);
    await service.getStatistics('org-1', 7);

    expect(repository.findByOrganization).toHaveBeenCalledWith('org-1', 25);
    expect(repository.getStatistics).toHaveBeenCalledWith('org-1', 7);
  });
});
