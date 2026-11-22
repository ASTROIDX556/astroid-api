import { describe, expect, it, vi } from 'vitest';
import { IdempotencyService } from './idempotency.service';
import {
  IdempotencyInFlightError,
  IdempotencyMismatchError,
} from './idempotency.types';
import { stableStringify } from './stable-json.util';

interface Row {
  id: string;
  principalId: string;
  route: string;
  keyHash: string;
  requestHash: string;
  status: 'PROCESSING' | 'COMPLETED';
  responseStatus: number | null;
  responseBody: unknown;
  requestId: string | null;
  expiresAt: Date;
}

function createPrisma() {
  const rows: Row[] = [];
  let id = 0;
  const identity = (where: { principalId: string; route: string; keyHash: string }) =>
    `${where.principalId}|${where.route}|${where.keyHash}`;

  const delegate = {
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      const predicate = (row: Row) =>
        (!where.principalId || row.principalId === where.principalId) &&
        (!where.route || row.route === where.route) &&
        (!where.keyHash || row.keyHash === where.keyHash) &&
        (!where.id || row.id === where.id) &&
        (!where.status || row.status === where.status) &&
        (!where.expiresAt ||
          row.expiresAt.getTime() <= (where.expiresAt as { lte: Date }).lte.getTime());
      for (let index = rows.length - 1; index >= 0; index--) {
        if (predicate(rows[index])) rows.splice(index, 1);
      }
      return { count: before - rows.length };
    }),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const key =
        'principalId_route_keyHash' in where
          ? identity(where.principalId_route_keyHash as never)
          : '';
      return rows.find((row) => identity(row) === key) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'responseStatus' | 'responseBody' | 'requestId'> }) => {
      if (rows.some((row) => identity(row) === identity(data))) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const row: Row = {
        ...data,
        id: `rec-${++id}`,
        responseStatus: null,
        responseBody: null,
        requestId: null,
      };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    }),
  };

  return { rows, prisma: { idempotencyRecord: delegate } };
}

function createRedis(acquired = true) {
  return {
    set: vi.fn().mockResolvedValue(acquired ? 'OK' : null),
    eval: vi.fn().mockResolvedValue(1),
  };
}

function settings() {
  return {
    get: vi.fn().mockReturnValue({
      keyTtlMs: 24 * 60 * 60 * 1000,
      waitTimeoutMs: 5_000,
      pollIntervalMs: 100,
    }),
  };
}

const scope = {
  principalId: 'user-1',
  route: 'POST /api/v1/transactions',
  key: 'key-abc',
  requestBody: { amount: '10', asset: 'USDC' },
};

describe('IdempotencyService', () => {
  it('executes the first request and replays the stored response', async () => {
    const { prisma } = createPrisma();
    const service = new IdempotencyService(prisma as never, settings() as never, createRedis() as never);

    const first = await service.begin(scope);
    expect(first.replay).toBeUndefined();
    await first.complete({ statusCode: 201, body: { id: 'tx-1' }, requestId: 'req-original' });

    const second = await service.begin(scope);
    expect(second.replay).toEqual({
      statusCode: 201,
      body: { id: 'tx-1' },
      requestId: 'req-original',
    });
  });

  it('scopes keys by principal and route', async () => {
    const { prisma } = createPrisma();
    const service = new IdempotencyService(prisma as never, settings() as never, createRedis() as never);
    const first = await service.begin(scope);
    await first.complete({ statusCode: 201, body: { id: 'tx-1' } });

    const otherPrincipal = await service.begin({ ...scope, principalId: 'user-2' });
    const otherRoute = await service.begin({ ...scope, route: 'POST /api/v1/webhooks' });

    expect(otherPrincipal.replay).toBeUndefined();
    expect(otherRoute.replay).toBeUndefined();
  });

  it('hashes request bodies deterministically regardless of key order', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('rejects the same key with a different body', async () => {
    const { prisma } = createPrisma();
    const service = new IdempotencyService(prisma as never, settings() as never, createRedis() as never);
    const first = await service.begin(scope);
    await first.complete({ statusCode: 201, body: { id: 'tx-1' } });

    await expect(
      service.begin({ ...scope, requestBody: { amount: '11', asset: 'USDC' } }),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
  });

  it('rejects a concurrent duplicate while the original is in flight', async () => {
    const { prisma } = createPrisma();
    const service = new IdempotencyService(prisma as never, settings() as never, createRedis() as never);
    await service.begin(scope);

    await expect(service.begin(scope)).rejects.toBeInstanceOf(IdempotencyInFlightError);
  });

  it('rejects a duplicate when the Redis lock is already held', async () => {
    const { prisma } = createPrisma();
    const service = new IdempotencyService(prisma as never, settings() as never, createRedis(false) as never);

    await expect(service.begin(scope)).rejects.toBeInstanceOf(IdempotencyInFlightError);
  });

  it('allows a retry after a failed execution', async () => {
    const { prisma, rows } = createPrisma();
    const service = new IdempotencyService(prisma as never, settings() as never, createRedis() as never);
    const first = await service.begin(scope);
    await first.fail();
    expect(rows).toHaveLength(0);

    const retry = await service.begin(scope);
    expect(retry.replay).toBeUndefined();
    await retry.complete({ statusCode: 201, body: { id: 'tx-2' } });
  });

  it('ignores and removes an expired record', async () => {
    const { prisma, rows } = createPrisma();
    const service = new IdempotencyService(prisma as never, settings() as never, createRedis() as never);
    const first = await service.begin(scope);
    await first.complete({ statusCode: 201, body: { id: 'tx-1' } });
    rows[0].expiresAt = new Date(Date.now() - 1_000);

    const fresh = await service.begin(scope);
    expect(fresh.replay).toBeUndefined();
    expect(rows).toHaveLength(1);
  });

  it('does not fail the request when the completion write fails', async () => {
    const { prisma } = createPrisma();
    prisma.idempotencyRecord.update.mockRejectedValueOnce(new Error('db down'));
    const service = new IdempotencyService(prisma as never, settings() as never, createRedis() as never);

    const handle = await service.begin(scope);
    await expect(handle.complete({ statusCode: 201, body: { id: 'tx-1' } })).resolves.toBeUndefined();
  });

  it('works without Redis, relying on the durable unique record', async () => {
    const { prisma } = createPrisma();
    const service = new IdempotencyService(prisma as never, settings() as never);
    const handle = await service.begin(scope);
    await handle.complete({ statusCode: 201, body: { id: 'tx-1' } });

    expect((await service.begin(scope)).replay?.body).toEqual({ id: 'tx-1' });
  });
});
