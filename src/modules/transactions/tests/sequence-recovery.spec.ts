import { Test, TestingModule } from '@nestjs/testing';
import { StellarTxService } from '../services/stellar-tx.service';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Keypair, Account } from '@stellar/stellar-sdk';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: vi.fn(),
        submitTransaction: vi.fn(),
      })),
    },
  };
});

describe('StellarTxService Sequence Recovery', () => {
  let service: StellarTxService;
  let redisMock: { set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };
  let horizonServerMock: { loadAccount: ReturnType<typeof vi.fn>; submitTransaction: ReturnType<typeof vi.fn> };
  const mockConfigService = {
    get: vi.fn().mockReturnValue('https://horizon-testnet.stellar.org'),
  };

  beforeEach(async () => {
    redisMock = {
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarTxService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: Redis, useValue: redisMock },
      ],
    }).compile();

    service = module.get<StellarTxService>(StellarTxService);
    // Cast horizon back to a mockable type so we can mock the methods easily
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    horizonServerMock = (service as any).horizon;
  });

  it('should successfully submit transaction on first try', async () => {
    const keypair = Keypair.random();
    const accountResponse = new Account(keypair.publicKey(), '100');
    
    horizonServerMock.loadAccount.mockResolvedValue(accountResponse);
    horizonServerMock.submitTransaction.mockResolvedValue({ successful: true });

    const buildFn = vi.fn().mockImplementation((_acc: unknown) => {
      return { sign: vi.fn() };
    });

    const result = await service.submitTransactionWithSequenceRecovery(keypair.secret(), buildFn) as { successful: boolean };
    
    expect(result.successful).toBe(true);
    expect(horizonServerMock.loadAccount).toHaveBeenCalledTimes(1);
    expect(horizonServerMock.submitTransaction).toHaveBeenCalledTimes(1);
    expect(redisMock.set).toHaveBeenCalledTimes(1);
    expect(redisMock.del).toHaveBeenCalledTimes(1);
  });

  it('should recover from tx_bad_seq and retry', async () => {
    const keypair = Keypair.random();
    const accountResponse1 = new Account(keypair.publicKey(), '100');
    const accountResponse2 = new Account(keypair.publicKey(), '101'); // sequence incremented
    
    horizonServerMock.loadAccount
      .mockResolvedValueOnce(accountResponse1)
      .mockResolvedValueOnce(accountResponse2);

    const badSeqError = {
      response: {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_bad_seq'
            }
          }
        }
      }
    };

    horizonServerMock.submitTransaction
      .mockRejectedValueOnce(badSeqError)
      .mockResolvedValueOnce({ successful: true });

    const buildFn = vi.fn().mockImplementation((_acc: unknown) => {
      return { sign: vi.fn() };
    });

    // Mock sleep to be instant
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    const result = await service.submitTransactionWithSequenceRecovery(keypair.secret(), buildFn) as { successful: boolean };
    
    expect(result.successful).toBe(true);
    expect(horizonServerMock.loadAccount).toHaveBeenCalledTimes(2);
    expect(horizonServerMock.submitTransaction).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((service as any).sleep).toHaveBeenCalledWith(1000); // 1st retry
  });

  it('should throw after 3 failed attempts due to tx_bad_seq', async () => {
    const keypair = Keypair.random();
    const accountResponse = new Account(keypair.publicKey(), '100');
    
    horizonServerMock.loadAccount.mockResolvedValue(accountResponse);

    const badSeqError = {
      response: {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_bad_seq'
            }
          }
        }
      }
    };

    horizonServerMock.submitTransaction.mockRejectedValue(badSeqError);

    const buildFn = vi.fn().mockImplementation((_acc: unknown) => {
      return { sign: vi.fn() };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await expect(service.submitTransactionWithSequenceRecovery(keypair.secret(), buildFn))
      .rejects.toThrow('Transaction failed after maximum sequence recovery attempts');
    
    expect(horizonServerMock.submitTransaction).toHaveBeenCalledTimes(3);
  });
});
