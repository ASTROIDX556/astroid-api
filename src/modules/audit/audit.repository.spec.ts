import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../database/prisma.service';
import { AuditRepository } from './audit.repository';

describe('AuditRepository.streamLogs', () => {
  it('fetches bounded pages and advances the cursor through every row', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'log-1' }, { id: 'log-2' }])
      .mockResolvedValueOnce([{ id: 'log-3' }]);
    const prisma = {
      auditLog: { findMany },
    } as unknown as PrismaService;
    const repository = new AuditRepository(prisma);
    const ids: string[] = [];

    for await (const record of repository.streamLogs({ organizationId: 'org-1' }, 2, 'start')) {
      ids.push(record.id);
    }

    expect(ids).toEqual(['log-1', 'log-2', 'log-3']);
    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { organizationId: 'org-1' },
        take: 2,
        cursor: { id: 'start' },
        skip: 1,
      }),
    );
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { organizationId: 'org-1' },
        take: 2,
        cursor: { id: 'log-2' },
        skip: 1,
      }),
    );
});

describe('AuditRepository.findPage', () => {
  it('uses a bounded deterministic keyset query with an ID tie-breaker', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn();
    const prisma = { auditLog: { findMany, count } } as unknown as PrismaService;
    const repository = new AuditRepository(prisma);
    const createdAt = new Date('2026-09-29T12:00:00.000Z');

    await repository.findPage(
      { organizationId: 'org-1' },
      { createdAt, id: 'audit-20' },
      21,
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { organizationId: 'org-1' },
          {
            OR: [
              { createdAt: { lt: createdAt } },
              { createdAt, id: { lt: 'audit-20' } },
            ],
          },
        ],
      },
      take: 21,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(count).not.toHaveBeenCalled();
  });

  it('uses a bounded first-page query without a cursor condition', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { auditLog: { findMany } } as unknown as PrismaService;
    const repository = new AuditRepository(prisma);

    await repository.findPage({ organizationId: 'org-2' }, undefined, 101);

    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-2' },
      take: 101,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });
});
