import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';

describe('AuditService', () => {
  let repository: { create: ReturnType<typeof vi.fn> };
  let hashService: {
    getLatestHash: ReturnType<typeof vi.fn>;
    computeEntryHash: ReturnType<typeof vi.fn>;
  };
  let service: AuditService;

  beforeEach(() => {
    repository = { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
    hashService = {
      getLatestHash: vi.fn().mockResolvedValue('prev-hash'),
      computeEntryHash: vi
        .fn()
        .mockReturnValue({ previousHash: 'prev-hash', hash: 'new-hash' }),
    };
    service = new AuditService(
      repository as unknown as AuditRepository,
      hashService as unknown as AuditHashService,
    );
  });

  it('persists the requestId alongside the entry without feeding it into the hash chain', async () => {
    await service.record({
      organizationId: 'org-1',
      userId: 'user-1',
      action: 'TRANSFER_FUNDS',
      entity: 'Transaction',
      entityId: 'tx-1',
      requestId: 'req_01HXYZ',
      ipAddress: '127.0.0.1',
      device: 'TestAgent/1.0',
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req_01HXYZ', hash: 'new-hash', previousHash: 'prev-hash' }),
    );

    const hashInput = hashService.computeEntryHash.mock.calls[0][0];
    expect(hashInput).not.toHaveProperty('requestId');
  });

  it('defaults requestId to null when not provided', async () => {
    await service.record({
      organizationId: 'org-1',
      userId: null,
      action: 'POLICY_CREATED',
      entity: 'Policy',
      entityId: 'policy-1',
    });

    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ requestId: null }));
  });
});
