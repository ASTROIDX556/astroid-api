import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { AuditListQuery } from './audit-list.dto';

describe('AuditService', () => {
  let repository: {
    createChained: ReturnType<typeof vi.fn>;
    findManyAndCount: ReturnType<typeof vi.fn>;
    findPage: ReturnType<typeof vi.fn>;
  };
  let hashService: {
    getLatestHash: ReturnType<typeof vi.fn>;
    computeEntryHash: ReturnType<typeof vi.fn>;
  };
  let service: AuditService;

  const baseQuery: AuditListQuery = { limit: 20 };

  beforeEach(() => {
    repository = {
      createChained: vi.fn().mockImplementation(async (data, computeHash) => {
        const id = 'audit-1';
        const prevHash = 'prev-hash';
        const createdAt = data.createdAt ?? new Date();
        return { ...data, id, prevHash, hash: computeHash(id, prevHash, createdAt) };
      }),
      findManyAndCount: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      findPage: vi.fn().mockResolvedValue([]),
    };
    hashService = {
      getLatestHash: vi.fn(),
      computeEntryHash: vi.fn().mockReturnValue({ prevHash: 'prev-hash', hash: 'new-hash' }),
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

    expect(repository.createChained).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req_01HXYZ',
      }),
      expect.any(Function),
    );

    const hashInput = hashService.computeEntryHash.mock.calls[0][0];
    expect(hashInput.id).toBe('audit-1');
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

    expect(repository.createChained).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: null }),
      expect.any(Function),
    );
  });

  it('redacts metadata before hashing and before handing it to the repository', async () => {
    const newValue = {
      requestId: 'req-safe-3',
      Authorization: 'Bearer fake.jwt.value',
      nested: [{ webhookSecret: 'fake-webhook-secret', amount: 10 }],
    };

    await service.record({
      organizationId: 'org-1',
      action: 'WEBHOOK_UPDATED',
      entity: 'Webhook',
      newValue,
    });

    const expected = {
      requestId: 'req-safe-3',
      Authorization: '[REDACTED]',
      nested: [{ webhookSecret: '[REDACTED]', amount: 10 }],
    };
    expect(hashService.computeEntryHash.mock.calls[0][0].newValue).toEqual(expected);
    expect(repository.createChained.mock.calls[0][0].newValue).toEqual(expected);
    expect(newValue.nested[0].webhookSecret).toBe('fake-webhook-secret');
  });

  describe('list', () => {
    it('returns first-page results and an opaque cursor when more records exist', async () => {
      repository.findManyAndCount.mockResolvedValue({
        items: Array.from({ length: 20 }, (_, index) => ({ id: `audit-${index}` })),
        total: 21,
      });

      const result = await service.list('org-1', baseQuery);

      expect(result.items).toHaveLength(20);
      expect(result.meta).toEqual({
        page: 1,
        pageSize: 20,
        total: 21,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });
    });

    it('uses the cursor and tenant-scoped combined filters for the next page', async () => {
      const createdAt = new Date('2026-09-29T12:00:00.000Z');
      const cursor = Buffer.from(JSON.stringify({ v: 1, createdAt: createdAt.toISOString(), id: 'audit-20' })).toString('base64url');
      repository.findPage.mockResolvedValue([{ id: 'audit-21', createdAt }]);

      const result = await service.list('org-1', {
        limit: 10,
        cursor,
        actorId: 'user-1',
        action: 'TRANSFER',
        resourceId: 'tx-1',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
      });

      const [where, decodedCursor, take] = repository.findPage.mock.calls[0];
      expect(where).toMatchObject({
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'TRANSFER',
        entityId: 'tx-1',
        createdAt: {
          gte: new Date('2026-09-01T00:00:00.000Z'),
          lte: new Date('2026-09-30T00:00:00.000Z'),
        },
      });
      expect(decodedCursor).toEqual({ createdAt, id: 'audit-20' });
      expect(take).toBe(11);
      expect(result.meta).toEqual({ limit: 10, hasMore: false, nextCursor: null });
    });

    it('returns no next cursor on an empty final page', async () => {
      repository.findManyAndCount.mockResolvedValue({ items: [], total: 0 });
      const result = await service.list('org-1', baseQuery);
      expect(result.items).toEqual([]);
      expect(result.meta).toMatchObject({
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });
  });
});
