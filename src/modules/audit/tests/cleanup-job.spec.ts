import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuditCleanupQueue } from '../queues/audit-cleanup.queue';
import { PrismaService } from '../../../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';

describe('AuditCleanupQueue', () => {
  let queue: AuditCleanupQueue;
  let mockPrisma: {
    organization: { findMany: ReturnType<typeof vi.fn> };
    auditLog: { findMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
    cleanupJobLog: { create: ReturnType<typeof vi.fn> };
  };
  let mockConfigService: Partial<ConfigService>;

  beforeEach(() => {
    mockPrisma = {
      organization: {
        findMany: vi.fn().mockResolvedValue([{ id: 'org-1' }]),
      },
      auditLog: {
        findMany: vi.fn().mockResolvedValueOnce([{ id: 'log-1' }]).mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      cleanupJobLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    mockConfigService = {
      get: vi.fn().mockReturnValue(90),
    };

    queue = new AuditCleanupQueue(
      mockPrisma as unknown as PrismaService,
      mockConfigService as ConfigService,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should clean up expired audit logs and record success', async () => {
    const job = { id: 'job-1' } as Job;
    await queue.process(job);

    expect(mockPrisma.organization.findMany).toHaveBeenCalled();
    expect(mockPrisma.auditLog.findMany).toHaveBeenCalled();
    expect(mockPrisma.auditLog.deleteMany).toHaveBeenCalled();
    
    expect(mockPrisma.cleanupJobLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobName: 'audit-cleanup',
          recordsDeleted: 1,
          status: 'SUCCESS',
        }),
      }),
    );
  });
});

