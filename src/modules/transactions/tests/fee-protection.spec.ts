import { ConfigService } from '@nestjs/config';
import { Horizon, Keypair, Transaction } from '@stellar/stellar-sdk';
import Redis from 'ioredis';
import { StellarTxService } from '../services/stellar-tx.service';

describe('StellarTxService fee protection', () => {
  let service: StellarTxService;
  let horizonMock: {
    feeStats: jest.Mock;
    loadAccount: jest.Mock;
    submitTransaction: jest.Mock;
  };
  let redisMock: { set: jest.Mock; del: jest.Mock };
  let sourceSecret: string;
  let configMock: { get: jest.Mock };

  beforeEach(() => {
    sourceSecret = Keypair.random().secret();

    horizonMock = {
      feeStats: jest.fn(),
      loadAccount: jest.fn(),
      submitTransaction: jest.fn(),
    };
    redisMock = {
      set: jest.fn().mockResolved('OK'),
      del: jest.fn().mockResolved(1),
    };

    configMock = {
      get: jest.fn(((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
          STELLAR_MAX_BASE_FEE: 1000,
          STELLAR_FEE_CONGESTION_MODE: 'fail',
        };
        return values[key] || defaultValue;
      }),
    };

    service = new StellarTxService(configMock as unknown as ConfigService, redisMock as unknown as Redis);
    (service as unknown as { horizon: typeof horizonMock }).horizon = horizonMock as unknown as Horizon.Server;
  });

  it('blocks submission when network base fee exceeds safety limit', async () => {
    horizonMock.feeStats.mockResolved({ last_ledger_base_fee: 2000 });

    const buildTxFn = jest.fn();

    await expect(
      service.submitTransactionWithSequenceRecovery(sourceSecret, buildTxFn),
    ).rejects.ToThrow('Network base fee 2000 stroops exceeds configured safety limit 1000 stroops');

    expect(buildTxFn).not.toHaveBeenCalled();
    expect(horizonMock.submitTransaction).not.toHaveBeenCalled();
  });

  it('submits when network base fee is within limits', async () => {
    horizonMock.feeStats.mockResolved({ last_ledger_base_fee: 100 });
    const account = { sequenceNumber: '1' } as Horizon.AccountResponse;
    const tx = { fee: 100, sign: jest.fn() } as unknown as Transaction;
    const submission = {
      hash: 'abc',
      successful: true,
      fee_charged: '100',
    } as Horizon.SubmitTransactionResponse;

    horizonMock.loadAccount.mockResolved(account);
    horizonMock.submitTransaction.mockResolved(submission);
    const buildTxFn = jest.fn().mockReturnValue(tx);

    const result = await service.submitTransactionWithSequenceRecovery(
      sourceSecret,
      buildTxFn,
    );

    expect(result).toEqual(submission);
    expect(buildTxFn).toHaveBeenCalledWith(account);
    expect(horizonMock.submitTransaction).toHaveBeenCalledWith(tx);
  });

  it('flag Mode returns FAILED_CONGESTION detail', async () => {
    horizonMock.feeStats.mockResolved({ last_ledger_base_fee: 2000 });
    const flagConfigMock = {
      get: jest.fn(((key: string, defaultValue?: unknown) => {
        const values: Record<string, unknown> = {
          STELLAR_MAX_BASE_FEE: 1000,
          STELLAR_FEE_CONGESTION_MODE: 'flag',
        };
        return values[key] || defaultValue;
      }),
    };
    const flagService = new StellarTxService(
      flagConfigMock as unknown as ConfigService,
      redisMock as unknown as Redis,
    );
    (flagService as unknown as { horizon: typeof horizonMock }).horizon = horizonMock as unknown as Horizon.Server;

    await expect(flagService.submitTransactionWithSequenceRecovery(sourceSecret, jest.fn()))
      .rejects.toMatchObject({
        details: { mode: 'flag', status: 'FAILED_CONGESTION' },
      });
  });
});
