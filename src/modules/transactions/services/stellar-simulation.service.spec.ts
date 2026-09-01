import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StellarSimulationService } from './stellar-simulation.service';
import {
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar/soroban.interface';
import { StellarClient } from '../../../integrations/stellar/stellar.interface';
import { DomainException } from '../../../common/exceptions/domain.exception';

function buildValidXdr(): string {
  return Buffer.from(
    JSON.stringify({ source: 'GABC...', destination: 'GDEF...', amount: '100' }),
  ).toString('base64');
}

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

function buildMockStellarClient(
  overrides: {
    balance?: string;
    isValid?: boolean;
    balanceError?: Error;
  } = {},
): StellarClient {
  return {
    generateKeypair: vi.fn(),
    isValidAddress: vi.fn().mockReturnValue(overrides.isValid ?? true),
    getBalances: vi.fn(),
    getNativeBalance: vi
      .fn()
      .mockImplementation(() =>
        overrides.balanceError ? Promise.reject(overrides.balanceError) : Promise.resolve(overrides.balance ?? '1000000000'),
      ),
    buildPaymentXdr: vi.fn(),
    submitPayment: vi.fn(),
    getTransaction: vi.fn(),
  } as unknown as StellarClient;
}

describe('StellarSimulationService', () => {
  let sorobanClient: ReturnType<typeof buildMockSorobanClient>;
  let stellarClient: ReturnType<typeof buildMockStellarClient>;
  let service: StellarSimulationService;

  beforeEach(() => {
    vi.clearAllMocks();
    sorobanClient = buildMockSorobanClient();
    stellarClient = buildMockStellarClient();
    service = new StellarSimulationService(sorobanClient, stellarClient);
  });

  describe('Soroban / contract simulation', () => {
    it('returns a structured report with fee estimate, cost, footprint and success probability', async () => {
      const report = await service.preflight({
        network: 'testnet',
        transactionXdr: buildValidXdr(),
      });

      expect(report.isSafeToSubmit).toBe(true);
      expect(report.feeEstimateStroops).toBe('100000');
      expect(report.feeWithinBound).toBe(true);
      expect(report.cost).toEqual({ cpuInstructions: 200_000, memoryBytes: 4096 });
      expect(report.footprint).toBeDefined();
      expect(report.successProbability).toBeGreaterThan(0);
      expect(report.successProbability).toBeLessThanOrEqual(100);
      expect(report.transactionHash).toBe('mock-hash-123');
      expect(report.isFallback).toBe(false);
    });

    it('warns and reports not-safe when the estimated fee exceeds the bound', async () => {
      sorobanClient = buildMockSorobanClient({ minResourceFee: '5000000' });
      service = new StellarSimulationService(sorobanClient, stellarClient);

      const report = await service.preflight({
        network: 'testnet',
        transactionXdr: buildValidXdr(),
        maxFeeStroops: 100000,
      });

      expect(report.isSafeToSubmit).toBe(false);
      expect(report.feeWithinBound).toBe(false);
      expect(report.warnings.some((w) => w.includes('exceeds'))).toBe(true);
      expect(report.failureReasons).toContain('fee exceedance');
    });

    it('warns when the simulation footprint writes ledger keys', async () => {
      sorobanClient = buildMockSorobanClient({
        footprint: {
          readOnly: [],
          readWrite: [{ contractId: 'contract-1', key: { symbol: 'Balance' } }],
        },
      });
      service = new StellarSimulationService(sorobanClient, stellarClient);

      const report = await service.preflight({
        network: 'testnet',
        transactionXdr: buildValidXdr(),
      });

      expect(report.warnings.some((w) => w.includes('writes'))).toBe(true);
    });

    it('reports a hard failure reason when the simulation returns an error', async () => {
      sorobanClient = buildMockSorobanClient({
        success: false,
        error: { code: 'txFailed', message: 'Contract revert: insufficient balance' },
      });
      service = new StellarSimulationService(sorobanClient, stellarClient);

      const report = await service.preflight({
        network: 'testnet',
        transactionXdr: buildValidXdr(),
      });

      expect(report.isSafeToSubmit).toBe(false);
      expect(report.failureReasons.join(' ')).toContain('insufficient balance');
    });

    it('throws a DomainException for an invalid base64 XDR', async () => {
      await expect(
        service.preflight({
          network: 'testnet',
          transactionXdr: '!!!not-base64-at-all&&&',
        }),
      ).rejects.toThrow('not valid base64');
    });

    it('falls back to a degraded report when the RPC client throws (network error)', async () => {
      (sorobanClient.simulateTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection refused'),
      );

      const report = await service.preflight({
        network: 'testnet',
        transactionXdr: buildValidXdr(),
      });

      expect(report.isFallback).toBe(true);
      expect(report.isSafeToSubmit).toBe(false);
      expect(report.failureReasons.some((r) => r.includes('simulation unavailable'))).toBe(true);
    });

    it('opens the circuit after repeated failures and fails fast via the fallback report', async () => {
      (sorobanClient.simulateTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
        Object.assign(new Error('Soroban RPC unreachable'), { code: 'ECONNREFUSED' }),
      );

      for (let i = 0; i < 5; i++) {
        const report = await service.preflight({
          network: 'testnet',
          transactionXdr: buildValidXdr(),
        });
        expect(report.isFallback).toBe(true);
      }
      expect(sorobanClient.simulateTransaction).toHaveBeenCalledTimes(5);

      (sorobanClient.simulateTransaction as ReturnType<typeof vi.fn>).mockClear();
      const openReport = await service.preflight({
        network: 'testnet',
        transactionXdr: buildValidXdr(),
      });

      expect(openReport.isFallback).toBe(true);
      expect(sorobanClient.simulateTransaction).not.toHaveBeenCalled();
    });
  });

  describe('Classic payment pre-flight', () => {
    it('validates source-account health and returns a safe report when funded', async () => {
      stellarClient = buildMockStellarClient({ balance: '1000000000' }); // 1000 XLM
      service = new StellarSimulationService(sorobanClient, stellarClient);

      const report = await service.preflight({
        network: 'testnet',
        source: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        destination: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        amount: '10',
        asset: 'XLM',
      });

      expect(stellarClient.getNativeBalance).toHaveBeenCalled();
      expect(report.isSafeToSubmit).toBe(true);
      expect(report.feeEstimateStroops).toBe('100');
    });

    it('reports a failure reason when the source account is invalid', async () => {
      stellarClient = buildMockStellarClient({ isValid: false });
      service = new StellarSimulationService(sorobanClient, stellarClient);

      const report = await service.preflight({
        network: 'testnet',
        source: 'GINVALIDACCOUNT',
        destination: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        amount: '10',
      });

      expect(report.isSafeToSubmit).toBe(false);
      expect(report.failureReasons.join(' ')).toContain('does not exist');
      expect(stellarClient.getNativeBalance).not.toHaveBeenCalled();
    });

    it('fails closed when the native balance fetch returns no result', async () => {
      stellarClient = buildMockStellarClient({
        balanceError: new Error('Horizon timeout'),
      });
      service = new StellarSimulationService(sorobanClient, stellarClient);

      const report = await service.preflight({
        network: 'testnet',
        source: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        destination: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        amount: '10',
      });

      // Account exists but we could not confirm balance; report must not be falsely safe.
      expect(report.isSafeToSubmit).toBe(false);
      expect(report.warnings.some((w) => w.includes('Unable to confirm'))).toBe(true);
    });
  });
});

describe('StellarSimulationService request validation', () => {
  it('rejects a request with neither an XDR nor payment fields', async () => {
    const sorobanClient = buildMockSorobanClient();
    const stellarClient = buildMockStellarClient();
    const service = new StellarSimulationService(sorobanClient, stellarClient);

    // The Zod schema enforces the either-or at the API boundary; the service
    // itself must also handle a malformed shape defensively.
    await expect(
      service.preflight({ network: 'testnet' } as never),
    ).rejects.toBeInstanceOf(DomainException);
  });
});
