import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SorobanSimulationService } from './soroban-simulation.service';
import { SorobanClient, SorobanSimulationResult } from '../../../integrations/stellar/soroban.interface';
import { RiskEngine } from '../../risk/risk.engine';
import { EventBusService } from '../../../events/event-bus.service';

function buildMockSorobanClient(overrides: Partial<SorobanSimulationResult> = {}): SorobanClient {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({
      success: true,
      minResourceFee: '100000',
      cost: { cpuInstructions: 200_000, memoryBytes: 4096 },
      footprint: {
        readOnly: [{ contractId: 'contract-1', key: { symbol: 'Balance' } }],
        readWrite: [],
      },
      events: [],
      result: undefined,
      transactionHash: 'mock-hash-123',
      ...overrides,
    } as SorobanSimulationResult),
  };
}

function buildMockEventBus() {
  return { emit: vi.fn().mockResolvedValue(undefined) };
}

function buildValidXdr(): string {
  return Buffer.from(
    JSON.stringify({ source: 'GABC...', destination: 'GDEF...', amount: '100' }),
  ).toString('base64');
}

describe('SorobanSimulationService', () => {
  let sorobanClient: ReturnType<typeof buildMockSorobanClient>;
  let eventBus: ReturnType<typeof buildMockEventBus>;
  let service: SorobanSimulationService;

  beforeEach(() => {
    vi.clearAllMocks();
    sorobanClient = buildMockSorobanClient();
    eventBus = buildMockEventBus();
    service = new SorobanSimulationService(
      sorobanClient,
      new RiskEngine(),
      eventBus as unknown as EventBusService,
    );
  });

  describe('simulate', () => {
    it('should return simulation results with risk assessment', async () => {
      const result = await service.simulate({
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
      });

      expect(result.success).toBe(true);
      expect(result.feeEstimate).toBe('100000');
      expect(result.risk).toBeDefined();
      expect(result.risk.score).toBeGreaterThanOrEqual(0);
      expect(result.risk.score).toBeLessThanOrEqual(100);
      expect(result.transactionHash).toBe('mock-hash-123');
    });

    it('should emit a risk evaluation event', async () => {
      await service.simulate({
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
        actorId: 'user-1',
      });

      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ score: expect.any(Number) }),
        expect.objectContaining({ organizationId: 'org-1', actorId: 'user-1' }),
      );
    });

    it('should throw DomainException for invalid base64 XDR', async () => {
      await expect(
        service.simulate({
          transactionXdr: '!!!not-base64-at-all&&&',
          organizationId: 'org-1',
        }),
      ).rejects.toThrow('not valid base64');
    });

    it('should throw DomainException for empty XDR', async () => {
      await expect(
        service.simulate({
          transactionXdr: '',
          organizationId: 'org-1',
        }),
      ).rejects.toThrow('Transaction XDR is required');
    });

    it('should throw DomainException when simulation returns failure', async () => {
      (sorobanClient.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        minResourceFee: '0',
        cost: { cpuInstructions: 0, memoryBytes: 0 },
        footprint: { readOnly: [], readWrite: [] },
        events: [],
        error: { code: 'txFailed', message: 'Contract Error' },
      });

      await expect(
        service.simulate({
          transactionXdr: buildValidXdr(),
          organizationId: 'org-1',
        }),
      ).rejects.toThrow('Contract Error');
    });

    it('should throw DomainException when soroban client throws', async () => {
      (sorobanClient.simulateTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection refused'),
      );

      await expect(
        service.simulate({
          transactionXdr: buildValidXdr(),
          organizationId: 'org-1',
        }),
      ).rejects.toThrow('Soroban simulation failed');
    });

    it('should throw RiskTooHighException when risk exceeds threshold', async () => {
      await expect(
        service.simulate({
          transactionXdr: buildValidXdr(),
          organizationId: 'org-1',
          maxRiskScore: -1,
        }),
      ).rejects.toThrow('exceeds maximum allowed');
    });

    it('should include risk factors when provided', async () => {
      const result = await service.simulate({
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
        riskFactors: {
          amount: 5000,
          asset: 'USDC',
          knownRecipient: true,
          recentTransactionCount: 2,
          walletAgeDays: 180,
          policyViolations: 0,
        },
      });

      expect(result.risk.score).toBeGreaterThanOrEqual(0);
      expect(result.risk.factors).toBeDefined();
    });

    it('should indicate requiresApproval when risk is above LOW', async () => {
      const result = await service.simulate({
        transactionXdr: buildValidXdr(),
        organizationId: 'org-1',
        maxRiskScore: 100,
        riskFactors: {
          amount: 50000,
          asset: 'XLM',
          knownRecipient: false,
          recentTransactionCount: 15,
          walletAgeDays: 5,
          policyViolations: 2,
        },
      });

      expect(result.requiresApproval).toBe(true);
    });
  });
});
