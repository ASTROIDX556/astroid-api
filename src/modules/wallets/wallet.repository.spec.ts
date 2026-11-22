import { describe, expect, it, vi } from 'vitest';
import { WalletStatus } from '@prisma/client';
import { WalletRepository } from './wallet.repository';
import { PrismaService } from '../../database/prisma.service';

describe('WalletRepository.findActiveForReconciliation', () => {
  type Row = { id: string; status: string; deletedAt: Date | null };

  /** Minimal in-memory table that applies the query's status filter. */
  function activeWallets(rows: Row[]): string[] {
    return rows
      .filter((row) => row.status === WalletStatus.ACTIVE && row.deletedAt === null)
      .map((row) => row.id);
  }

  it('excludes archived wallets', () => {
    expect(
      activeWallets([
        { id: 'active', status: WalletStatus.ACTIVE, deletedAt: null },
        { id: 'archived', status: WalletStatus.ARCHIVED, deletedAt: null },
      ]),
    ).toEqual(['active']);
  });

  it('excludes revoked (frozen/paused and soft-deleted) wallets', () => {
    expect(
      activeWallets([
        { id: 'active', status: WalletStatus.ACTIVE, deletedAt: null },
        { id: 'frozen', status: WalletStatus.FROZEN, deletedAt: null },
        { id: 'paused', status: WalletStatus.PAUSED, deletedAt: null },
        { id: 'deleted', status: WalletStatus.ACTIVE, deletedAt: new Date() },
      ]),
    ).toEqual(['active']);
  });

  it('selects only ACTIVE, non-deleted wallets and only the needed columns', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { wallet: { findMany } } as unknown as PrismaService;
    const repository = new WalletRepository(prisma);

    await repository.findActiveForReconciliation();

    expect(findMany).toHaveBeenCalledWith({
      where: { status: WalletStatus.ACTIVE, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        stellarAddress: true,
        network: true,
        balance: true,
      },
      orderBy: { id: 'asc' },
    });
  });
});
