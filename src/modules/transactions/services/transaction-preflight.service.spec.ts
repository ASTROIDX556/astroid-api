import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar/soroban.interface';
import { SorobanUnavailableException } from '../../../integrations/stellar/soroban.client';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';
import { classifyJobError } from '../../../queues/queue-policy';
import { TransactionPreflightService } from './transaction-preflight.service';

function simulation(overrides: Partial<SorobanSimulationResult> = {}): SorobanSimulationResult {
  return {
    success: true,
    latestLedger: 10,
    minResourceFee: '120000',
    cost: { cpuInstructions: 12, memoryBytes: 34 },
    footprint: {
      readOnly: [{ contractId: 'contract-1', key: 'key-1' }],
      readWrite: [
        { contractId: 'contract-1', key: 'key-2' },
        { contractId: 'contract-2', key: 'key-3' },
      ],
    },
    events: [],
    ...overrides,
  };
}

describe('TransactionPreflightService', () => {
  let client: {
    simulateTransaction: ReturnType<typeof vi.fn>;
    getLatestLedger: ReturnType<typeof vi.fn>;
  };
  let service: TransactionPreflightService;

  beforeEach(() => {
    client = {
      simulateTransaction: vi.fn().mockResolvedValue(simulation()),
      getLatestLedger: vi.fn().mockResolvedValue(10),
    };
    service = new TransactionPreflightService(client as unknown as SorobanClient);
  });

  it('returns the fee and a footprint summary for a current successful simulation', async () => {
    const result = await service.simulate('safe-xdr');

    expect(result).toMatchObject({
      kind: 'ok',
      minResourceFee: '120000',
      footprintSummary: { readOnlyCount: 1, readWriteCount: 2 },
    });
    expect(result.kind === 'ok' && result.simulatedAt).toBeInstanceOf(Date);
    expect(client.simulateTransaction).toHaveBeenCalledWith({ transactionXdr: 'safe-xdr' });
  });

  it('returns RPC simulation errors as terminal failures', async () => {
    client.simulateTransaction.mockResolvedValueOnce(
      simulation({
        success: false,
        error: { code: 'txINSUFFICIENT_BALANCE', message: 'not enough balance' },
      }),
    );

    await expect(service.simulate('safe-xdr')).resolves.toMatchObject({
      kind: 'terminal_error',
      code: 'txINSUFFICIENT_BALANCE',
      message: 'not enough balance',
    });
    expect(client.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(
      classifyJobError(
        new DomainException(ErrorCode.SIMULATION_FAILED, 'transaction simulation failed'),
      ),
    ).toBe('permanent');
  });

  it('re-simulates exactly once when the first result is stale', async () => {
    client.simulateTransaction
      .mockResolvedValueOnce(simulation({ latestLedger: 8 }))
      .mockResolvedValueOnce(simulation({ latestLedger: 10 }));
    client.getLatestLedger.mockResolvedValueOnce(9).mockResolvedValueOnce(10);

    const result = await service.simulate('safe-xdr');

    expect(result.kind).toBe('ok');
    expect(client.simulateTransaction).toHaveBeenCalledTimes(2);
    expect(client.getLatestLedger).toHaveBeenCalledTimes(2);
  });

  it('fails stale after one re-simulation and does not make a third call', async () => {
    client.simulateTransaction
      .mockResolvedValueOnce(simulation({ latestLedger: 8 }))
      .mockResolvedValueOnce(simulation({ latestLedger: 9 }));
    client.getLatestLedger.mockResolvedValueOnce(9).mockResolvedValueOnce(10);

    await expect(service.simulate('safe-xdr')).resolves.toMatchObject({
      kind: 'terminal_error',
      code: 'SIMULATION_STALE',
    });
    expect(client.simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('classifies Soroban transport failures as retryable', async () => {
    const error = new SorobanUnavailableException('RPC timed out', {
      endpoint: 'https://rpc.example',
      method: 'simulateTransaction',
      reason: 'timeout',
      attempts: 3,
    });
    client.simulateTransaction.mockRejectedValueOnce(error);

    const result = await service.simulate('safe-xdr');

    expect(result).toMatchObject({
      kind: 'retryable_error',
      code: 'SOROBAN_UNAVAILABLE',
      message: 'RPC timed out',
      error,
    });
    expect(classifyJobError(error)).toBe('retryable');
  });
});
