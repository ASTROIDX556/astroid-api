import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { RiskProcessor } from './risk.processor';
import type { RiskService } from '../modules/risk/risk.service';
import type { RiskAnalysisJobData } from '../modules/risk/risk.types';

describe('RiskProcessor', () => {
  it('passes queued transaction data to the risk service', async () => {
    const assessment = { score: 85, band: 'CRITICAL', factors: [], canAutoExecute: false };
    const riskService = {
      evaluateQueuedTransaction: vi.fn().mockResolvedValue(assessment),
    } as unknown as RiskService;
    const processor = new RiskProcessor(riskService);
    const data: RiskAnalysisJobData = {
      organizationId: 'org-1',
      transactionId: 'tx-1',
      input: {
        amount: 100_000,
        asset: 'XLM',
        knownRecipient: false,
        recentTransactionCount: 20,
        walletAgeDays: 0,
        policyViolations: 0,
      },
    };
    const job = {
      id: 'risk-job-1',
      name: 'risk-evaluation',
      data,
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as Job<RiskAnalysisJobData>;

    await expect(processor.process(job)).resolves.toEqual(assessment);
    expect(riskService.evaluateQueuedTransaction).toHaveBeenCalledWith(data);
  });
});