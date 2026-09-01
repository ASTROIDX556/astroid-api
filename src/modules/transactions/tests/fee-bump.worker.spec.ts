import { Test, TestingModule } from '@nestjs/testing';
import { FeeBumpWorker, FeeBumpJobData } from '../workers/fee-bump.worker';
import { ConfigService } from '@nestjs/config';
import { Keypair, Transaction, Networks, Account, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';

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

describe('FeeBumpWorker', () => {
  let worker: FeeBumpWorker;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let horizonServerMock: { loadAccount: ReturnType<typeof vi.fn>; submitTransaction: ReturnType<typeof vi.fn> };
  const sponsorKeypair = Keypair.random();
  const mockConfigService = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'STELLAR_FEE_SPONSOR_SECRET') return sponsorKeypair.secret();
      return 'https://horizon-testnet.stellar.org';
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeeBumpWorker,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    worker = module.get<FeeBumpWorker>(FeeBumpWorker);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    horizonServerMock = (worker as any).horizon;
  });

  const generateMockInnerTxXdr = () => {
    const kp = Keypair.random();
    const account = new Account(kp.publicKey(), '1');
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
      .setTimeout(0)
      .build();
    tx.sign(kp);
    return tx.toXDR();
  };

  it('should process standard transaction without fee bump', async () => {
    horizonServerMock.submitTransaction.mockResolvedValue({ successful: true });

    const job = {
      data: {
        organizationId: 'org1',
        isSponsorshipEnabled: false,
        innerTransactionXdr: generateMockInnerTxXdr(),
        networkPassphrase: Networks.TESTNET,
      } as FeeBumpJobData,
    } as Job;

    const result = await worker.process(job);

    expect(result.successful).toBe(true);
    // Should not load sponsor account
    expect(horizonServerMock.loadAccount).not.toHaveBeenCalled();
    // Submit standard tx
    const submittedTx = horizonServerMock.submitTransaction.mock.calls[0][0];
    expect(submittedTx).toBeInstanceOf(Transaction);
  });

  it('should build and submit a fee bump transaction if enabled', async () => {
    horizonServerMock.loadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '100.00' }]
    });
    horizonServerMock.submitTransaction.mockResolvedValue({ successful: true, fee_charged: 10000 });

    const job = {
      data: {
        organizationId: 'org1',
        isSponsorshipEnabled: true,
        innerTransactionXdr: generateMockInnerTxXdr(),
        networkPassphrase: Networks.TESTNET,
      } as FeeBumpJobData,
    } as Job;

    const result = await worker.process(job);

    expect(result.successful).toBe(true);
    expect(horizonServerMock.loadAccount).toHaveBeenCalled();
    const submittedTx = horizonServerMock.submitTransaction.mock.calls[0][0];
    // FeeBumpTransaction is not exported the same way in all SDK versions, but we can check property
    expect(submittedTx.innerTransaction).toBeDefined(); 
    expect(submittedTx.feeSource).toBe(sponsorKeypair.publicKey());
  });

  it('should throw if sponsor has insufficient funds', async () => {
    horizonServerMock.loadAccount.mockResolvedValue({
      balances: [{ asset_type: 'native', balance: '0.1' }]
    });

    const job = {
      data: {
        organizationId: 'org1',
        isSponsorshipEnabled: true,
        innerTransactionXdr: generateMockInnerTxXdr(),
        networkPassphrase: Networks.TESTNET,
      } as FeeBumpJobData,
    } as Job;

    await expect(worker.process(job)).rejects.toThrow('Failed to apply fee bump: Sponsor account lacks sufficient XLM for fee bump.');
    expect(horizonServerMock.submitTransaction).not.toHaveBeenCalled();
  });
});
