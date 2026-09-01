import { ConfigService } from '@nestjs/config';
import { Horizon, Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import Redis from 'ioredis';

import { DynamicFeeExceededException } from '../../../common/exceptions/domain.exception';
import { StellarTxService } from '../services/stellar-tx.service';
import { TransactionRepository } from '../transaction.repository';

type MockConfigService = Pick<ConfigService, 'get'>;
type MockRedis = Pick<Redis, 'set' | 'del'>;
type MockTransactionRepository = Pick<TransactionRepository, 'markAsCongestionBlocked' | 'recordFeeMetrics'>

describe('StellarTxService fee protection', () => {
  let service: StellarTxService;
  let configService: MockConfigService;
  let redis: MockRedis;
  let transactionRepository: MockTransactionRepository;
  let feeStatsSpy: jest.SpyInstance;
  let submitSpy: jest.SpyInstance;
  let loadAccountSpy: jest.SpyInstance;

  beforeEach(() => {
    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'stellar') {
          return {
            feeProtection: {
              enabled: true,
              maxBaseFee: 100,
              fallbackMode: 'fail',
              feeStatsIntervalMs: 30000,
            },
          };
        }
        if (key === 'STELLAR_HORIZON_URL') return 'https://horizon-testnet.stellar.org';
        return undefined;
      }),
    };

    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    transactionRepository = {
      markAsCongestionBlocked: jest.fn().mockResolvedValue(undefined),
      recordFeeMetrics: jest.fn().mockResolvedValue(undefined),
    } as unknown as TransactionRepository;

    service = new StellarTxService(
      configService as unknown as ConfigService,
      redis as unknown as Redis,
      transactionRepository,
    );

    feeStatsSpy = jest.spyOn(Horizon.Server.prototype, 'feeStats');
    submitSpy = jest.spyOn(Horizon.Server.prototype, 'submitTransaction');
    loadAccountSpy = jest.spyOn(Horizon.Server.prototype, 'loadAccount');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws DynamicFeeExceededException and does not submit when base fee exceeds limit in fail mode', async () => {
    feeStatsSpy.mockResolvedValue({
      last_ledger_base_fee: '200',
    } as unknown as Horizon.FeeStatsResponse);

    const buildTx = jest.fn();

    await expect(
      service.submitTransactionWithSequenceRecovery(
        Keypair.random().secret(),
        buildTx,
        Networks.TESTNET,
      ),
    ).rejects.toThrow(DynamicFeeExceededException);

    expect(buildTx).notTohaveBeenCalled();
    expect(transactionRepository.markAsCongestionBlocked).notTohaveBeenCalled();
  });

  it('marks transaction as FAILED_CONGESTION when fallback mode is congestion', async () => {
    configService.get = jest.fn().mockImplementation((key: string) => {
      if (key === 'stellar') {
        return {
          feeProtection: {
            enabled: true,
            maxBaseFee: 100,
            fallbackMode: 'congestion',
            feeStatsIntervalMs: 30000,
          },
        };
      }
      if (key === 'STELLAR_HORIZON_URL') return 'https://horizon-testnet.stellar.org';
      return undefined;
    });

    feeStatsSpy.mockResolvedValue({
      last_ledger_base_fee: '200',
    } as unknown as Horizon.FeeStatsResponse);

    const buildTx = jest.fn();

    const result = await service.submitTransactionWithSequenceRecovery(
      Keypair.random().secret(),
      buildTx,
      Networks.TESTNET,
      'tx-id-1',
    );

    expect(result).toEqual({ status: 'FAILED_CONGESTION', currentBaseFee: 200, maxBaseFee: 100 });
    expect(transactionRepository.markAsCongestionBlocked).tohaveBeenCalledWith('tx-id-1', 200);
    expect(buildTx).notTohaveBeenCalled();
  });

  it('submits successfully and records fee metrics', async () => {
    feeStatsSpy.mockResolvedValue({
      last_ledger_base_fee: '50',
    } as unknown as Horizon.FeeStatsResponse);

    loadAccountSpy.mockResolvedValue({} as Horizon.AccountResponse);

    const transaction = {
      operations: [{}, {}],
      sign: jest.fn(),
    } as unknown as Transaction;

    const buildTx = jest.fn().mockReturnValue(transaction);

    submitSpy.mockResolvedValue({
      fee_charged: '80',
      hash: 'abc',
      successful: true,
    } as Horizon.TransactionResponse);

    const result = await service.submitTransactionWithSequenceRecovery(
      Keypair.random().secret(),
      buildTx,
      Networks.TESTNET,
      'tx-id-2',
    );

    expect(result).toMatchObject({ successful: true, hash: 'abc' });
    expect(transactionRepository.recordFeeMetrics).tohaveBeenCalledWith('tx-id-2', 100, 80);
  });
}
