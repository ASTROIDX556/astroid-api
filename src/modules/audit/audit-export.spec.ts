import { describe, it, expect, vi } from 'vitest';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';

describe('AuditService - Export Compliance', () => {
  const mockRepository = {
    exportLogs: vi.fn(),
    create: vi.fn(),
    findManyAndCount: vi.fn(),
    findById: vi.fn(),
  };

  const mockHashService = {
    getLatestHash: vi.fn().mockResolvedValue(null),
    computeEntryHash: vi.fn().mockReturnValue({ previousHash: null, hash: 'mock-hash' }),
    verifyChainIntegrity: vi.fn(),
    verifyEntryIntegrity: vi.fn(),
  };

  const auditService = new AuditService(
    mockRepository as unknown as AuditRepository,
    mockHashService as unknown as AuditHashService,
  );

  it('should export audit logs in JSON format with pagination cursor', async () => {
    const mockLogs = [
      {
        id: 'log-1',
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'AGENT_PAYMENT_INITIATED',
        entity: 'Transaction',
        entityId: 'tx-1',
        ipAddress: '127.0.0.1',
        device: 'AgentRunner/1.0',
        oldValue: { amount: 10 },
        newValue: { amount: 20 },
        createdAt: new Date('2026-08-28T10:00:00Z'),
        user: { id: 'user-1', email: 'auditor@example.com', name: 'Auditor' },
      },
    ];

    mockRepository.exportLogs.mockResolvedValueOnce(mockLogs);

    const result = await auditService.export('org-123', {
      format: 'json',
      limit: 10,
      actionType: 'AGENT_PAYMENT_INITIATED',
    });

    expect(result.format).toBe('json');
    expect(result.count).toBe(1);
    expect(result.data).toEqual(mockLogs);
    expect(mockRepository.exportLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-123',
        action: 'AGENT_PAYMENT_INITIATED',
      }),
      10,
      undefined,
    );
  });

  it('should export audit logs in CSV format properly escaped', async () => {
    const mockLogs = [
      {
        id: 'log-1',
        organizationId: 'org-123',
        userId: 'user-1',
        action: 'POLICY_OVERRIDE,ADMIN',
        entity: 'Policy',
        entityId: 'pol-1',
        ipAddress: '127.0.0.1',
        device: 'Desktop',
        oldValue: { limit: 500 },
        newValue: { limit: 1000 },
        createdAt: new Date('2026-08-28T10:00:00Z'),
        user: { id: 'user-1', email: 'admin@example.com', name: 'Admin' },
      },
    ];

    mockRepository.exportLogs.mockResolvedValueOnce(mockLogs);

    const result = await auditService.export('org-123', {
      format: 'csv',
      limit: 10,
    });

    expect(result.format).toBe('csv');
    expect(typeof result.data).toBe('string');
    expect(result.data).toContain('id,organizationId,userId');
    expect(result.data).toContain('"POLICY_OVERRIDE,ADMIN"');
  });

  it('should handle empty records gracefully', async () => {
    mockRepository.exportLogs.mockResolvedValueOnce([]);

    const result = await auditService.export('org-123', {
      format: 'csv',
      limit: 10,
    });

    expect(result.format).toBe('csv');
    expect(result.count).toBe(0);
    expect(result.data).toBe(
      'id,organizationId,userId,userEmail,action,entity,entityId,ipAddress,device,oldValue,newValue,createdAt',
    );
  });
});
