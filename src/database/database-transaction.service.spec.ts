import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { DatabaseTransactionService } from './database-transaction.service';
import { PrismaTransactionService } from './prisma-transaction.service';

describe('DatabaseTransactionService (#420)', () => {
  it('commits multi-step callbacks through PrismaTransactionService', async () => {
    const fakeTx = {} as Prisma.TransactionClient;
    const prismaTx = {
      run: vi.fn().mockImplementation(async (fn: (tx: Prisma.TransactionClient) => Promise<string>) =>
        fn(fakeTx),
      ),
    } as unknown as PrismaTransactionService;

    const service = new DatabaseTransactionService(prismaTx);
    const outcome = await service.executeInTransaction(async (tx) => {
      expect(tx).toBe(fakeTx);
      return 'committed';
    });

    expect(outcome).toBe('committed');
    expect(prismaTx.run).toHaveBeenCalledTimes(1);
  });

  it('propagates errors and aborts the transaction when a mid-step write fails', async () => {
    const prismaTx = {
      run: vi.fn().mockRejectedValue(new Error('mid-transaction ledger write failure')),
    } as unknown as PrismaTransactionService;

    const service = new DatabaseTransactionService(prismaTx);
    await expect(
      service.executeInTransaction(async () => {
        throw new Error('mid-transaction ledger write failure');
      }),
    ).rejects.toThrow('mid-transaction ledger write failure');
  });
});
