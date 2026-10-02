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
});

describe('AuditRepository', () => {
  it('upserts event-backed audit rows by source event ID', async () => {
    const prisma = {
      auditLog: {
        create: vi.fn(),
        upsert: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    const repository = new AuditRepository(prisma as unknown as PrismaService);
    const record = {
      organizationId: 'org-1',
      action: 'transaction.created',
      entity: 'transaction',
      sourceEventId: 'event-1',
    };

    await repository.create(record);
    await repository.create(record);

    expect(prisma.auditLog.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sourceEventId: 'event-1' }, update: {} }),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
