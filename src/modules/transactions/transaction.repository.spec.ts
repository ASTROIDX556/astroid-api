import { describe, expect, it, vi } from 'vitest';
import { TransactionRepository } from './transaction.repository';
import { PrismaService } from '../../database/prisma.service';

describe('TransactionRepository', () => {
  it('scopes a transaction lookup to the organization and excludes soft-deleted rows', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { transaction: { findFirst } } as unknown as PrismaService;
    const repository = new TransactionRepository(prisma);

    await repository.findById('org_1', 'tx_1');

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'tx_1', organizationId: 'org_1', deletedAt: null },
    });
  });
});
