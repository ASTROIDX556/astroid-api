import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../database/prisma.service';
import {
  AUDIT_LIST_ORDER_BY,
  AuditLogFilters,
  AuditRepository,
  buildAuditLogWhere,
  CreateAuditLogData,
} from './audit.repository';
import { AUDIT_CHAIN_GENESIS, computeAuditEntryHash } from './audit-hash';

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

  describe('AuditRepository.createChained', () => {
    it('serializes concurrent appends so every row links to its predecessor', async () => {
      const records: Array<CreateAuditLogData & { id: string; prevHash: string; hash: string }> = [];
      let lockQueue = Promise.resolve();
      const prisma = {
        $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
          let releaseLock: () => void = () => {};
          const tx = {
            $queryRaw: vi.fn(async () => {
              const previousLock = lockQueue;
              lockQueue = new Promise<void>((resolve) => {
                releaseLock = resolve;
              });
              await previousLock;
              return [];
            }),
            auditLog: {
              findFirst: vi.fn(async () => {
                const ordered = [...records].sort(
                  (left, right) =>
                    left.createdAt!.getTime() - right.createdAt!.getTime() ||
                    left.id.localeCompare(right.id),
                );
                const latest = ordered[ordered.length - 1];
                return latest ? { hash: latest.hash, createdAt: latest.createdAt } : null;
              }),
              create: vi.fn(async ({ data }: { data: typeof records[number] }) => {
                records.push(data);
                return data;
              }),
              upsert: vi.fn(),
            },
            auditLogArchive: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
          };
          try {
            return await callback(tx);
          } finally {
            releaseLock();
          }
        }),
      };
      const repository = new AuditRepository(prisma as unknown as PrismaService);
      const createdAt = new Date('2026-11-22T14:00:00.000Z');

      await Promise.all(
        Array.from({ length: 20 }, (_, index) => {
          const action = `ACTION_${index}`;
          const entityId = `agent-${index}`;
          return repository.createChained(
            {
              organizationId: 'org-1',
              action,
              entity: 'Agent',
              entityId,
              createdAt,
            },
            (id, prevHash, timestamp) =>
              computeAuditEntryHash(
                {
                  id,
                  actor: null,
                  action,
                  target: { entity: 'Agent', id: entityId },
                  timestamp,
                  payload: { oldValue: null, newValue: null, ipAddress: null, device: null },
                },
                prevHash,
              ),
          );
        }),
      );

      const ordered = [...records].sort(
        (left, right) =>
          left.createdAt!.getTime() - right.createdAt!.getTime() ||
          left.id.localeCompare(right.id),
      );
      let expectedPreviousHash = AUDIT_CHAIN_GENESIS;
      for (const record of ordered) {
        expect(record.prevHash).toBe(expectedPreviousHash);
        expectedPreviousHash = record.hash;
      }
      expect(ordered).toHaveLength(20);
      expect(prisma.$transaction).toHaveBeenCalledTimes(20);
    });
  });
});

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

  it('inverts the keyset comparison and ordering for ascending timelines', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new AuditRepository({ auditLog: { findMany } } as unknown as PrismaService);
    const createdAt = new Date('2026-09-29T12:00:00.000Z');

    await repository.findPage({ organizationId: 'org-1', entityId: 'tx-1' }, { createdAt, id: 'audit-20' }, 21, 'asc');

    expect(findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { organizationId: 'org-1', entityId: 'tx-1' },
          {
            OR: [
              { createdAt: { gt: createdAt } },
              { createdAt, id: { gt: 'audit-20' } },
            ],
          },
        ],
      },
      take: 21,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('never looks the cursor row up, so archived or deleted cursors keep working', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new AuditRepository({ auditLog: { findMany } } as unknown as PrismaService);
    const createdAt = new Date('2026-01-01T00:00:00.000Z');

    await repository.findPage({ organizationId: 'org-1' }, { createdAt, id: 'gone' }, 5);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { organizationId: 'org-1' },
          {
            OR: [
              { createdAt: { lt: createdAt } },
              { createdAt, id: { lt: 'gone' } },
            ],
          },
        ],
      },
      take: 5,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('passes composable filters through unchanged', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new AuditRepository({ auditLog: { findMany } } as unknown as PrismaService);
    const where = {
      organizationId: 'org-1',
      userId: 'user-1',
      action: 'TRANSFER',
      entity: 'Transaction',
      entityId: 'tx-1',
      createdAt: {
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-30T00:00:00.000Z'),
      },
    };

    await repository.findPage(where, undefined, 10);

    expect(findMany).toHaveBeenCalledWith({
      where,
      take: 10,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });
});

describe('buildAuditLogWhere', () => {
  const from = '2026-09-01T00:00:00.000Z';
  const to = '2026-09-30T23:59:59.999Z';

  it('applies only the organization scope when no filter is given', () => {
    expect(buildAuditLogWhere('org-1', {})).toEqual({ organizationId: 'org-1' });
  });

  it.each([
    { name: 'actorId', filters: { actorId: 'user-1' }, expected: { userId: 'user-1' } },
    { name: 'action', filters: { action: 'transaction.created' }, expected: { action: 'transaction.created' } },
    { name: 'resourceType', filters: { resourceType: 'Transaction' }, expected: { entity: 'Transaction' } },
    { name: 'resourceId', filters: { resourceId: 'tx-1' }, expected: { entityId: 'tx-1' } },
    { name: 'from', filters: { from }, expected: { createdAt: { gte: new Date(from) } } },
    { name: 'to', filters: { to }, expected: { createdAt: { lte: new Date(to) } } },
  ])('maps $name on its own to an exact predicate next to the organization scope', ({ filters, expected }) => {
    expect(buildAuditLogWhere('org-1', filters)).toEqual({ organizationId: 'org-1', ...expected });
  });

  it('combines every filter with the organization scope and an inclusive createdAt range', () => {
    expect(
      buildAuditLogWhere('org-1', {
        actorId: 'user-1',
        action: 'transaction.created',
        resourceType: 'Transaction',
        resourceId: 'tx-1',
        from,
        to,
      }),
    ).toEqual({
      organizationId: 'org-1',
      userId: 'user-1',
      action: 'transaction.created',
      entity: 'Transaction',
      entityId: 'tx-1',
      createdAt: { gte: new Date(from), lte: new Date(to) },
    });
  });

  it('leaves out filters that are not provided or empty', () => {
    const where = buildAuditLogWhere('org-1', { actorId: undefined, action: '', resourceId: 'tx-1' });

    expect(where).toEqual({ organizationId: 'org-1', entityId: 'tx-1' });
  });

  it('keeps the organization scope even if a caller smuggles an organizationId filter in', () => {
    const smuggled = { organizationId: 'org-2', actorId: 'user-1' } as AuditLogFilters;

    expect(buildAuditLogWhere('org-1', smuggled)).toEqual({ organizationId: 'org-1', userId: 'user-1' });
  });

  it('adds search and JSON-path filters under AND without touching the organization scope', () => {
    const where = buildAuditLogWhere('org-2', { search: 'wallet', agentId: 'agent-1', resourceId: 'tx-1' });

    expect(where.organizationId).toBe('org-2');
    expect(where.entityId).toBe('tx-1');
    expect(where.AND).toHaveLength(2);
  });
});

describe('AuditRepository.findManyAndCount', () => {
  function repositoryWith(findMany: ReturnType<typeof vi.fn>, count: ReturnType<typeof vi.fn>) {
    const prisma = {
      auditLog: { findMany, count },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    return new AuditRepository(prisma as unknown as PrismaService);
  }

  it('always orders by createdAt DESC, id DESC and counts with the same where', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const where = { organizationId: 'org-1', userId: 'user-1' };

    await repositoryWith(findMany, count).findManyAndCount(where, { skip: 40, take: 20 });

    expect(findMany).toHaveBeenCalledWith({
      where,
      skip: 40,
      take: 20,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(count).toHaveBeenCalledWith({ where });
    expect(AUDIT_LIST_ORDER_BY).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('ignores a caller-supplied order so the listing order cannot become non-deterministic', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const legacyPagination = { skip: 0, take: 20, orderBy: { createdAt: 'desc' as const } };

    await repositoryWith(findMany, count).findManyAndCount({ organizationId: 'org-1' }, legacyPagination);

    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('Audit pagination stability with identical timestamps', () => {
  type Row = { id: string; organizationId: string; createdAt: Date };
  type OrderBy = Array<Partial<Record<keyof Row, 'asc' | 'desc'>>>;
  type KeysetOr = [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }];
  type FindManyArgs = {
    where: { organizationId?: string; AND?: [{ organizationId: string }, { OR: KeysetOr }] };
    orderBy: OrderBy;
    skip?: number;
    take: number;
  };

  // Ten rows in one organization; rows 3-7 share a timestamp, so with a page
  // size of 3 the tie straddles two page boundaries. One row of another
  // organization must never show up.
  const tie = new Date('2026-09-15T12:00:00.000Z');
  const rows: Row[] = [
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `audit-${String(index).padStart(2, '0')}`,
      organizationId: 'org-1',
      createdAt: index >= 3 && index <= 7 ? tie : new Date(Date.UTC(2026, 8, 15, 0, 0, index)),
    })),
    { id: 'audit-99', organizationId: 'org-2', createdAt: tie },
  ];

  const compare = (orderBy: OrderBy) => (left: Row, right: Row) => {
    for (const key of orderBy) {
      const [field, direction] = Object.entries(key)[0] as [keyof Row, 'asc' | 'desc'];
      const a = left[field];
      const b = right[field];
      const diff =
        a instanceof Date && b instanceof Date ? a.getTime() - b.getTime() : String(a).localeCompare(String(b));
      if (diff !== 0) return direction === 'asc' ? diff : -diff;
    }
    return 0;
  };

  /**
   * In-memory `auditLog.findMany` honouring the organization scope, the
   * descending keyset predicate, `orderBy`, `skip` and `take`. Like
   * PostgreSQL, it guarantees nothing about rows the `orderBy` considers equal:
   * each call scans the rows in a different physical order, so only a total
   * order (with the `id` tie-breaker) yields consistent pages.
   */
  function inMemoryRepository() {
    const stored = [rows[5], rows[10], rows[0], rows[7], rows[3], rows[9], rows[4], rows[1], rows[6], rows[8], rows[2]];
    let calls = 0;
    const findMany = vi.fn(async (args: FindManyArgs) => {
      const organizationId = args.where.organizationId ?? args.where.AND?.[0].organizationId;
      const keyset = args.where.AND?.[1].OR;
      const skip = args.skip ?? 0;
      const shift = (calls++ * 3) % stored.length;
      const scan = calls % 2 === 0
        ? [...stored.slice(shift), ...stored.slice(0, shift)]
        : [...stored.slice(shift), ...stored.slice(0, shift)].reverse();
      return scan
        .filter((row) => row.organizationId === organizationId)
        .filter(
          (row) =>
            !keyset ||
            row.createdAt < keyset[0].createdAt.lt ||
            (row.createdAt.getTime() === keyset[1].createdAt.getTime() && row.id < keyset[1].id.lt),
        )
        .sort(compare(args.orderBy))
        .slice(skip, skip + args.take);
    });
    const prisma = {
      auditLog: { findMany, count: vi.fn(async () => 10) },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    return new AuditRepository(prisma as unknown as PrismaService);
  }

  const expected = rows
    .filter((row) => row.organizationId === 'org-1')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .map((row) => row.id);

  it('returns every row exactly once across offset pages', async () => {
    const repository = inMemoryRepository();
    const seen: string[] = [];

    for (let skip = 0; skip < expected.length; skip += 3) {
      const { items } = await repository.findManyAndCount({ organizationId: 'org-1' }, { skip, take: 3 });
      seen.push(...(items as unknown as Row[]).map((row) => row.id));
    }

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });

  it('returns every row exactly once across keyset pages', async () => {
    const repository = inMemoryRepository();
    const seen: string[] = [];
    let cursor: { createdAt: Date; id: string } | undefined;

    for (let page = 0; page < 10; page += 1) {
      const items = (await repository.findPage({ organizationId: 'org-1' }, cursor, 3)) as unknown as Row[];
      if (items.length === 0) break;
      seen.push(...items.map((row) => row.id));
      const last = items[items.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });
});
