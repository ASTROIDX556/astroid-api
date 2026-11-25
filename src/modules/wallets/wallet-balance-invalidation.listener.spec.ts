import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StellarNetwork } from '@prisma/client';
import { WalletBalanceInvalidationListener } from './wallet-balance-invalidation.listener';
import { PrismaService } from '../../database/prisma.service';
import { BalanceCacheService } from './services/balance-cache.service';

const ADDRESS = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';

describe('WalletBalanceInvalidationListener', () => {
  let prisma: { transaction: { findUnique: ReturnType<typeof vi.fn> } };
  let cache: { invalidate: ReturnType<typeof vi.fn> };
  let listener: WalletBalanceInvalidationListener;

  beforeEach(() => {
    prisma = {
      transaction: {
        findUnique: vi.fn().mockResolvedValue({
          wallet: { stellarAddress: ADDRESS, network: StellarNetwork.TESTNET },
        }),
      },
    };
    cache = { invalidate: vi.fn().mockResolvedValue(undefined) };
    listener = new WalletBalanceInvalidationListener(
      prisma as unknown as PrismaService,
      cache as unknown as BalanceCacheService,
    );
  });

  it('invalidates the wallet balance after a completed transaction', async () => {
    await listener.onTransactionCompleted({ transactionId: 'tx_1' });

    expect(prisma.transaction.findUnique).toHaveBeenCalledWith({
      where: { id: 'tx_1' },
      select: { wallet: { select: { stellarAddress: true, network: true } } },
    });
    expect(cache.invalidate).toHaveBeenCalledWith(ADDRESS, 'testnet');
  });

  it('invalidates after a failed transaction', async () => {
    await listener.onTransactionFailed({ transactionId: 'tx_2', reason: 'boom' });
    expect(cache.invalidate).toHaveBeenCalledWith(ADDRESS, 'testnet');
  });

  it('invalidates after a cancelled transaction', async () => {
    await listener.onTransactionCancelled({ transactionId: 'tx_3' });
    expect(cache.invalidate).toHaveBeenCalledWith(ADDRESS, 'testnet');
  });

  it('maps the public network to its lowercase cache namespace', async () => {
    prisma.transaction.findUnique.mockResolvedValue({
      wallet: { stellarAddress: ADDRESS, network: StellarNetwork.PUBLIC },
    });

    await listener.onTransactionCompleted({ transactionId: 'tx_4' });

    expect(cache.invalidate).toHaveBeenCalledWith(ADDRESS, 'public');
  });

  it('does nothing when the transaction no longer exists', async () => {
    prisma.transaction.findUnique.mockResolvedValue(null);

    await listener.onTransactionCompleted({ transactionId: 'tx_gone' });

    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('never propagates a lookup failure into the event bus', async () => {
    const warn = vi
      .spyOn((await import('@nestjs/common')).Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    prisma.transaction.findUnique.mockRejectedValue(new Error('database down'));

    await expect(
      listener.onTransactionCompleted({ transactionId: 'tx_5' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it('ignores a payload without a transaction id', async () => {
    await listener.onTransactionCompleted({} as { transactionId: string });
    expect(prisma.transaction.findUnique).not.toHaveBeenCalled();
  });
});
