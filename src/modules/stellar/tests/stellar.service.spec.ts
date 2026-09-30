import { Test, TestingModule } from '@nestjs/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StellarService } from '../services/stellar.service';
import {
  STELLAR_CLIENT,
  SOROBAN_CLIENT,
  StellarClient,
  SorobanClient,
  SorobanSimulationResult,
} from '../../../integrations/stellar';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';

/** Runs `promise` and resolves with the thrown error instead of rejecting. */
const caught = async (promise: Promise<unknown>): Promise<DomainException | null> =>
  promise.then(
    () => null,
    (e: unknown) => e as DomainException,
  );

describe('StellarService - Transaction Simulation', () => {
  let service: StellarService;
  let mockSorobanClient: SorobanClient;
  let mockStellarClient: StellarClient;

  beforeEach(async () => {
    mockSorobanClient = {
      simulateTransaction: vi.fn(),
    } as unknown as SorobanClient;

    mockStellarClient = {
      generateKeypair: vi.fn(),
      isValidAddress: vi.fn().mockReturnValue(true),
      getBalances: vi.fn(),
      getNativeBalance: vi.fn(),
      buildPaymentXdr: vi.fn(),
      submitPayment: vi.fn(),
      getTransactionInfo: vi.fn(),
    } as unknown as StellarClient;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarService,
        {
          provide: STELLAR_CLIENT,
          useValue: mockStellarClient,
        },
        {
          provide: SOROBAN_CLIENT,
          useValue: mockSorobanClient,
        },
      ],
    }).compile();

    service = module.get<StellarService>(StellarService);
  });

  it('should successfully simulate a valid transaction XDR', async () => {
    const mockResult: SorobanSimulationResult = {
      success: true,
      minResourceFee: '100',
      cost: { cpuInstructions: 1000, memoryBytes: 2048 },
      footprint: { readOnly: [], readWrite: [] },
      events: [],
      result: 'AAAA...',
      transactionHash: 'sim_123',
    };
    vi.spyOn(mockSorobanClient, 'simulateTransaction').mockResolvedValue(mockResult);

    const result = await service.simulateTransaction('AAAA...valid_xdr');

    expect(result).toEqual(mockResult);
    expect(mockSorobanClient.simulateTransaction).toHaveBeenCalledWith({
      transactionXdr: 'AAAA...valid_xdr',
    });
  });

  it('should throw DomainException when transaction XDR is empty or invalid', async () => {
    const error = await caught(service.simulateTransaction(''));

    expect(error).toBeInstanceOf(DomainException);
    expect(error?.code).toBe(ErrorCode.INVALID_STELLAR_TRANSACTION);
  });

  it('should handle simulation failure and Soroban error codes correctly', async () => {
    const errorResult: SorobanSimulationResult = {
      success: false,
      minResourceFee: '0',
      cost: { cpuInstructions: 0, memoryBytes: 0 },
      footprint: { readOnly: [], readWrite: [] },
      events: [],
      error: {
        code: 'Contract',
        message: 'HostError: Error(Contract, #4)',
      },
    };
    vi.spyOn(mockSorobanClient, 'simulateTransaction').mockResolvedValue(errorResult);

    const error = await caught(service.simulateTransaction('AAAA...trap_xdr'));

    expect(error).toBeInstanceOf(DomainException);
    expect(error?.code).toBe(ErrorCode.STELLAR_ERROR);
    expect(error?.message).toContain('Simulation failed: HostError: Error(Contract, #4)');
  });

  it('should handle RPC network timeouts and errors robustly', async () => {
    vi.spyOn(mockSorobanClient, 'simulateTransaction').mockRejectedValue(new Error('RPC timeout'));

    const error = await caught(service.simulateTransaction('AAAA...timeout_xdr'));

    expect(error).toBeInstanceOf(DomainException);
    expect(error?.code).toBe(ErrorCode.STELLAR_ERROR);
    expect(error?.message).toContain('RPC timeout');
  });
});
