import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService, deriveAuditOutcome } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditHashService } from './audit-hash.service';
import { AuditListQuery } from './audit-list.dto';
import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor';
import { ZodValidationException } from '../../common/pipes/zod-validation.pipe';
import { CursorPaginationMeta } from '../../common/interfaces/api-response.interface';

type AuditRow = { id: string; createdAt: Date; action?: string; entity?: string; userId?: string };

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
  const startCursor = encodeAuditCursor({
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    id: 'audit-start',
  });

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
      const cursor = encodeAuditCursor({ createdAt, id: 'audit-20' });
      repository.findPage.mockResolvedValue([{ id: 'audit-21', createdAt }]);

      const result = await service.list('org-1', {
        limit: 10,
        cursor,
        actorId: 'user-1',
        action: 'TRANSFER',
        resourceType: 'Transaction',
        resourceId: 'tx-1',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
      });

      const [where, decodedCursor, take] = repository.findPage.mock.calls[0];
      expect(where).toMatchObject({
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'TRANSFER',
        entity: 'Transaction',
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

    it.each([
      { name: 'actor id', query: { actorId: 'user-1' }, expected: { userId: 'user-1' } },
      { name: 'action type', query: { action: 'TRANSFER' }, expected: { action: 'TRANSFER' } },
      { name: 'resource type', query: { resourceType: 'Transaction' }, expected: { entity: 'Transaction' } },
      { name: 'resource id', query: { resourceId: 'tx-1' }, expected: { entityId: 'tx-1' } },
      {
        name: 'inclusive time range',
        query: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
        expected: {
          createdAt: {
            gte: new Date('2026-09-01T00:00:00.000Z'),
            lte: new Date('2026-09-30T00:00:00.000Z'),
          },
        },
      },
    ])('maps the $name filter into the repository where clause', async ({ query, expected }) => {
      await service.list('org-1', { ...query, limit: 5, cursor: startCursor });

      expect(repository.findPage.mock.calls[0][0]).toMatchObject({
        organizationId: 'org-1',
        ...expected,
      });
    });

    it('emits hasMore and a cursor based on the last returned row, not the extra probe row', async () => {
      const timestamp = new Date('2026-09-29T12:00:00.000Z');
      const rows: AuditRow[] = [
        { id: 'audit-3', createdAt: timestamp },
        { id: 'audit-2', createdAt: timestamp },
        { id: 'audit-1', createdAt: timestamp },
      ];
      repository.findPage.mockResolvedValue(rows);

      const result = await service.list('org-1', { limit: 2, cursor: startCursor });

      expect(result.items.map((item) => item.id)).toEqual(['audit-3', 'audit-2']);
      expect(result.meta.hasMore).toBe(true);
      expect(decodeAuditCursor((result.meta as CursorPaginationMeta).nextCursor as string)).toEqual({
        createdAt: timestamp,
        id: 'audit-2',
      });
    });

    it('reports hasMore false and nextCursor null on the final page', async () => {
      const timestamp = new Date('2026-09-29T12:00:00.000Z');
      repository.findPage.mockResolvedValue([
        { id: 'audit-2', createdAt: timestamp },
        { id: 'audit-1', createdAt: timestamp },
      ]);

      const result = await service.list('org-1', { limit: 2, cursor: startCursor });

      expect(result.meta).toEqual({ limit: 2, hasMore: false, nextCursor: null });
    });

    it('rejects a malformed cursor with the standard 400 validation error', async () => {
      await expect(service.list('org-1', { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
        ZodValidationException,
      );
      expect(repository.findPage).not.toHaveBeenCalled();
    });

    it('does not skip or duplicate rows when entries arrive between page fetches', async () => {
      const ids = ['audit-1', 'audit-2', 'audit-3', 'audit-4', 'audit-5'];
      let rows: AuditRow[] = ids.map((id, index) => ({
        id,
        createdAt: new Date(Date.UTC(2026, 8, 29, 12, 0, index)),
      }));
      repository.findPage.mockImplementation(async (
        _where: unknown,
        cursor: { createdAt: Date; id: string } | undefined,
        take: number,
      ) => {
        const ordered = [...rows].sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
        );
        const remaining = cursor
          ? ordered.filter((row) => {
              const difference = row.createdAt.getTime() - cursor.createdAt.getTime();
              return difference < 0 || (difference === 0 && row.id < cursor.id);
            })
          : ordered;
        return remaining.slice(0, take);
      });

      const seen: string[] = [];
      let cursor: string = encodeAuditCursor({
        createdAt: new Date('2026-09-29T12:10:00.000Z'),
        id: 'audit-start',
      });
      for (let page = 0; page < 10; page += 1) {
        if (page === 1) {
          rows = [
            { id: 'audit-newer', createdAt: new Date('2026-09-29T12:11:00.000Z') },
            ...rows,
          ];
        }
        const result = await service.list('org-1', { limit: 2, cursor });
        seen.push(...result.items.map((item) => item.id));
        const next = (result.meta as CursorPaginationMeta).nextCursor;
        if (!next) break;
        cursor = next;
      }

      expect(seen).toEqual([...ids].reverse());
    });

    it('does not skip or duplicate rows when timestamps are identical', async () => {
      const timestamp = new Date('2026-09-29T12:00:00.000Z');
      const ids = ['audit-005', 'audit-004', 'audit-003', 'audit-002', 'audit-001'];
      const rows: AuditRow[] = ids.map((id) => ({ id, createdAt: timestamp }));
      repository.findPage.mockImplementation(async (
        _where: unknown,
        cursor: { createdAt: Date; id: string } | undefined,
        take: number,
      ) =>
        rows
          .filter((row) => !cursor || row.id < cursor.id)
          .sort((left, right) => right.id.localeCompare(left.id))
          .slice(0, take));

      const seen: string[] = [];
      let cursor: string = encodeAuditCursor({
        createdAt: new Date('2026-09-29T13:00:00.000Z'),
        id: 'audit-start',
      });
      for (let page = 0; page < 10; page += 1) {
        const result = await service.list('org-1', { limit: 2, cursor });
        seen.push(...result.items.map((item) => item.id));
        const next = (result.meta as CursorPaginationMeta).nextCursor;
        if (!next) break;
        cursor = next;
      }

      expect(seen).toEqual(ids);
    });
  });

  describe('timeline', () => {
    it('pages a resource timeline in ascending order with the same cursor protocol', async () => {
      const timestamp = new Date('2026-09-29T12:00:00.000Z');
      repository.findPage.mockResolvedValue([
        { id: 'audit-1', createdAt: timestamp },
        { id: 'audit-2', createdAt: timestamp },
        { id: 'audit-3', createdAt: timestamp },
      ]);

      const result = await service.timeline('org-1', 'tx-1', {
        limit: 2,
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
      });

      expect(repository.findPage).toHaveBeenCalledWith(
        {
          organizationId: 'org-1',
          entityId: 'tx-1',
          createdAt: {
            gte: new Date('2026-09-01T00:00:00.000Z'),
            lte: new Date('2026-09-30T00:00:00.000Z'),
          },
        },
        undefined,
        3,
        'asc',
      );
      expect(result.items.map((item) => item.id)).toEqual(['audit-1', 'audit-2']);
      expect(result.meta).toEqual({
        limit: 2,
        hasMore: true,
        nextCursor: encodeAuditCursor({ createdAt: timestamp, id: 'audit-2' }),
      });
    });

    it('decodes the cursor for the next timeline page and closes it on the final page', async () => {
      const timestamp = new Date('2026-09-29T12:00:00.000Z');
      const cursor = encodeAuditCursor({ createdAt: timestamp, id: 'audit-2' });
      repository.findPage.mockResolvedValueOnce([{ id: 'audit-3', createdAt: timestamp }]);

      const result = await service.timeline('org-1', 'tx-1', { limit: 2, cursor });

      expect(repository.findPage.mock.calls[0][1]).toEqual({ createdAt: timestamp, id: 'audit-2' });
      expect(repository.findPage.mock.calls[0][2]).toBe(3);
      expect(repository.findPage.mock.calls[0][3]).toBe('asc');
      expect(result.items.map((item) => item.id)).toEqual(['audit-3']);
      expect(result.meta).toEqual({ limit: 2, hasMore: false, nextCursor: null });
    });

    it('rejects a malformed timeline cursor before querying the repository', async () => {
      await expect(
        service.timeline('org-1', 'tx-1', { limit: 5, cursor: 'not-a-cursor' }),
      ).rejects.toBeInstanceOf(ZodValidationException);
      expect(repository.findPage).not.toHaveBeenCalled();
    });
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

    it('combines actor, resource, action, outcome and search filters under one tenant', async () => {
      await service.list('org-1', {
        limit: 20,
        actorId: 'user-1',
        resourceType: 'transaction',
        resourceId: 'tx-1',
        action: 'TRANSFER_FUNDS',
        outcome: 'FAILURE',
        search: 'transfer',
      });

      const [where] = repository.findPage.mock.calls[0];
      expect(where).toMatchObject({
        organizationId: 'org-1',
        userId: 'user-1',
        entity: 'transaction',
        entityId: 'tx-1',
        action: 'TRANSFER_FUNDS',
        outcome: 'FAILURE',
      });
      expect(where.AND).toEqual([
        {
          OR: [
            { action: { contains: 'transfer', mode: 'insensitive' } },
            { entity: { contains: 'transfer', mode: 'insensitive' } },
            { entityId: { contains: 'transfer', mode: 'insensitive' } },
            { requestId: { contains: 'transfer', mode: 'insensitive' } },
          ],
        },
      ]);
    });

    it('never drops the tenant predicate, even when every filter is supplied', async () => {
      await service.list('org-2', {
        limit: 5,
        actorId: 'user-9',
        action: 'POLICY_CREATED',
        resourceType: 'policy',
        resourceId: 'policy-9',
        outcome: 'SUCCESS',
        search: 'policy',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
      });

      const [where] = repository.findPage.mock.calls[0];
      expect(where.organizationId).toBe('org-2');
    });
  });

  describe('deriveAuditOutcome', () => {
    it('prefers an explicit boolean success in the payload', () => {
      expect(deriveAuditOutcome({ action: 'X', newValue: { success: true } })).toBe('SUCCESS');
      expect(deriveAuditOutcome({ action: 'X', newValue: { success: false } })).toBe('FAILURE');
    });

    it('falls back to the action suffix and leaves undecidable rows null', () => {
      expect(deriveAuditOutcome({ action: 'webhook.delivery.failed' })).toBe('FAILURE');
      expect(deriveAuditOutcome({ action: 'policy.violated' })).toBe('FAILURE');
      expect(deriveAuditOutcome({ action: 'transaction.created' })).toBeNull();
      expect(deriveAuditOutcome({ action: 'X', newValue: ['not-an-object'] })).toBeNull();
    });
  });
});
