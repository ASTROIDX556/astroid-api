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