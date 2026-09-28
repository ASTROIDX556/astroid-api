import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { PaginationQuery } from '../../common/helpers/pagination';

describe('AuditService', () => {
  let repository: {
    create: ReturnType<typeof vi.fn>;
    findManyAndCount: ReturnType<typeof vi.fn>;
  };
  let hashService: {
    getLatestHash: ReturnType<typeof vi.fn>;
    computeEntryHash: ReturnType<typeof vi.fn>;
  };
  let service: AuditService;

  const baseQuery: PaginationQuery = {
    page: 1,
    limit: 20,
    sort: 'createdAt',
    order: 'desc',
  };

  beforeEach(() => {
    repository = {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      findManyAndCount: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    hashService = {
      getLatestHash: vi.fn().mockResolvedValue('prev-hash'),
      computeEntryHash: vi.fn().mockReturnValue({ previousHash: 'prev-hash', hash: 'new-hash' }),
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
      expect.objectContaining({
        requestId: 'req_01HXYZ',
        hash: 'new-hash',
        previousHash: 'prev-hash',
      }),
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

  describe('list', () => {
    it('returns paginated results with metadata for a normal page', async () => {
      repository.findManyAndCount.mockResolvedValue({
        items: [{ id: 'a1' }, { id: 'a2' }],
        total: 45,
      });

      const result = await service.list('org-1', { ...baseQuery, page: 2, limit: 20 });

      expect(result.items).toHaveLength(2);
      expect(result.meta).toEqual({
        page: 2,
        limit: 20,
        total: 45,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
      });
    });

    it('returns empty results without error', async () => {
      repository.findManyAndCount.mockResolvedValue({ items: [], total: 0 });

      const result = await service.list('org-1', baseQuery);

      expect(result.items).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(result.meta.hasNext).toBe(false);
      expect(result.meta.hasPrev).toBe(false);
    });

    it('handles an out-of-bounds page by returning empty items with correct meta', async () => {
      repository.findManyAndCount.mockResolvedValue({ items: [], total: 5 });

      const result = await service.list('org-1', { ...baseQuery, page: 99, limit: 20 });

      expect(result.items).toEqual([]);
      expect(result.meta.page).toBe(99);
      expect(result.meta.hasNext).toBe(false);
    });

    it('falls back to createdAt when an unsortable field is requested', async () => {
      await service.list('org-1', { ...baseQuery, sort: 'not-a-real-column' });

      const pagination = repository.findManyAndCount.mock.calls[0][1];
      expect(pagination.orderBy).toEqual({ createdAt: 'desc' });
    });

    it('applies ascending sort order when requested', async () => {
      await service.list('org-1', { ...baseQuery, sort: 'action', order: 'asc' });

      const pagination = repository.findManyAndCount.mock.calls[0][1];
      expect(pagination.orderBy).toEqual({ action: 'asc' });
    });

    it('filters by entity when filter is provided', async () => {
      await service.list('org-1', { ...baseQuery, filter: 'Transaction' });

      const where = repository.findManyAndCount.mock.calls[0][0];
      expect(where.entity).toBe('Transaction');
    });
  });
});
