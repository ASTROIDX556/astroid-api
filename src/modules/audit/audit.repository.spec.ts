import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../database/prisma.service';
import { AuditRepository } from './audit.repository';

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