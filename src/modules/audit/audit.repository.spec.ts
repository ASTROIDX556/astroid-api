import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../database/prisma.service';
import { AuditRepository } from './audit.repository';

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