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

describe('TransactionRepository.findCursorPage', () => {
  it('asks for limit + 1 rows with the tenant filter and a keyset cursor', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn();
    const prisma = { transaction: { findMany, count } } as unknown as PrismaService;
    const repository = new TransactionRepository(prisma);
    const createdAt = new Date('2026-09-29T12:00:00.000Z');

    await repository.findCursorPage(
      { organizationId: 'org-1', deletedAt: null },
      { createdAt, id: 'tx-20' },
      21,
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { organizationId: 'org-1', deletedAt: null },
          {
            OR: [
              { createdAt: { lt: createdAt } },
              { createdAt, id: { lt: 'tx-20' } },
            ],
          },
        ],
      },
      take: 21,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    // No count query: the extra row is what tells us another page exists.
    expect(count).not.toHaveBeenCalled();
  });

  it('queries the first page without a cursor condition', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { transaction: { findMany } } as unknown as PrismaService;
    const repository = new TransactionRepository(prisma);

    await repository.findCursorPage({ organizationId: 'org-1' }, undefined, 11);

    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      take: 11,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });
});
