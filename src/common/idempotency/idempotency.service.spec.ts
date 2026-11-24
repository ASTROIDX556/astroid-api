import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdempotencyRecord } from '@prisma/client';
import { IdempotencyService } from './idempotency.service';
import { PrismaService } from '../../database/prisma.service';
import { RequestContext, RequestContextData } from '../context/request-context';
import {
  IDEMPOTENT_REPLAY,
  IDEMPOTENT_REPLAY_REQUEST_ID,
  IDEMPOTENT_REPLAY_STATUS,
} from './idempotency.constants';
import { computeRequestFingerprint } from './request-fingerprint';

const ROUTE = 'POST /transactions';
const OTHER_ROUTE = 'POST /transactions/execute';

/**
 * In-memory `transaction_idempotency_records` table. It enforces the same
 * (principal, route, keyHash) uniqueness as the database constraint.
 */
function createPrisma() {
  const rows = new Map<string, IdempotencyRecord>();
  let sequence = 0;

  const matchesIdentity = (row: IdempotencyRecord, where: Record<string, unknown>) =>
    (typeof where.principalId !== 'string' || row.principalId === where.principalId) &&
    (typeof where.scope !== 'string' || row.scope === where.scope) &&
    (typeof where.route !== 'string' || row.route === where.route) &&
    (typeof where.keyHash !== 'string' || row.keyHash === where.keyHash);

  return {
    rows,
    prisma: {
      idempotencyRecord: {
        deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          let count = 0;
          for (const [id, row] of rows) {
            if (typeof where.id === 'string' && where.id !== id) continue;
            if (!matchesIdentity(row, where)) continue;
            const expiry = where.expiresAt as { lte?: Date } | undefined;
            if (expiry?.lte && row.expiresAt.getTime() > expiry.lte.getTime()) continue;
            if ('transactionId' in where && where.transactionId === null && row.transactionId !== null) {
              continue;
            }
            rows.delete(id);
            count += 1;
          }
          return { count };
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const duplicate = [...rows.values()].some(
            (row) =>
              row.scope === data.scope &&
              row.route === data.route &&
              row.keyHash === data.keyHash,
          );
          if (duplicate) throw { code: 'P2002' };
          const row: IdempotencyRecord = {
            id: `idem_${(sequence += 1)}`,
            principalId: data.principalId as string,
            scope: (data.scope as string | undefined) ?? (data.principalId as string),
            route: data.route as string,
            keyHash: data.keyHash as string,
            requestHash: data.requestHash as string,
            status: 'PROCESSING',
            transactionId: null,
            responseBody: null,
            responseStatus: null,
            requestId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            expiresAt: data.expiresAt as Date,
          };
          rows.set(row.id, row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (typeof where.id === 'string') return rows.get(where.id) ?? null;
          const identity = where.scope_route_keyHash as Record<string, unknown>;
          return (
            [...rows.values()].find((row) => matchesIdentity(row, identity)) ?? null
          );
        }),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = rows.get(where.id);
            if (!row) throw new Error(`missing record ${where.id}`);
            const updated = { ...row, ...data } as IdempotencyRecord;
            rows.set(row.id, updated);
            return updated;
          },
        ),
        updateMany: vi.fn(
          async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            const matching = [...rows.values()].filter(
              (row) => row.transactionId === where.transactionId && row.status === where.status,
            );
            for (const row of matching) {
              rows.set(row.id, { ...row, ...data } as IdempotencyRecord);
            }
            return { count: matching.length };
          },
        ),
      },
    } as unknown as PrismaService,
  };
}

function requestContext(requestId: string): RequestContextData {
  return {
    identity: {
      requestId,
      correlationId: requestId,
      traceId: requestId,
      method: 'POST',
      path: '/transactions',
      url: '/transactions',
      ip: null,
      userAgent: null,
      startedAt: Date.now(),
    },
    timings: {},
    data: {},
  };
}

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let store: ReturnType<typeof createPrisma>;
  const fingerprint = (amount = '50') => computeRequestFingerprint({ body: { amount } });
  const reserveInput = (overrides: Record<string, unknown> = {}) => ({
    principalId: 'user_1',
    route: ROUTE,
    key: 'key-1',
    requestFingerprint: fingerprint(),
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });

  beforeEach(() => {
    store = createPrisma();
    service = new IdempotencyService(store.prisma);
  });

  it('creates a PROCESSING record on the first request', async () => {
    const result = await service.reserve(reserveInput());

    expect(result.created).toBe(true);
    expect(result.record.status).toBe('PROCESSING');
    expect(result.record.route).toBe(ROUTE);
    expect(store.rows.size).toBe(1);
  });

  it('replays the cached status, body and request id of a completed record', async () => {
    const { record } = await service.reserve(reserveInput());
    await service.complete({
      recordId: record.id,
      statusCode: 201,
      body: { transaction: { id: 'tx_1' } },
      transactionId: 'tx_1',
      requestId: 'req-original',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const replayed = await service.reserve(reserveInput());
    expect(replayed.created).toBe(false);
    expect(service.completedResponse(replayed.record)).toEqual({
      statusCode: 201,
      body: { transaction: { id: 'tx_1' } },
      requestId: 'req-original',
    });
  });

  it('replays the original request id and status through the request context', async () => {
    const { record } = await service.reserve(reserveInput());
    await service.complete({
      recordId: record.id,
      statusCode: 201,
      body: { ok: true },
      requestId: 'req-original',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const replayed = await service.reserve(reserveInput());

    await RequestContext.run(requestContext('req-duplicate'), async () => {
      const body = service.replay<{ ok: boolean }>(service.completedResponse(replayed.record)!);
      expect(body).toEqual({ ok: true });
      expect(RequestContext.getData(IDEMPOTENT_REPLAY_REQUEST_ID)).toBe('req-original');
      expect(RequestContext.getData(IDEMPOTENT_REPLAY_STATUS)).toBe(201);
    });
  });

  it('marks the request context as a replay so the envelope carries idempotentReplay', async () => {
    const { record } = await service.reserve(reserveInput());
    await service.complete({
      recordId: record.id,
      statusCode: 201,
      body: { ok: true },
      requestId: 'req-original',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const replayed = await service.reserve(reserveInput());

    await RequestContext.run(requestContext('req-duplicate'), async () => {
      service.replay<{ ok: boolean }>(service.completedResponse(replayed.record)!);
      expect(RequestContext.getData(IDEMPOTENT_REPLAY)).toBe(true);
    });
  });

  it('scopes the same key independently by route', async () => {
    await service.reserve(reserveInput());
    const other = await service.reserve(reserveInput({ route: OTHER_ROUTE }));

    expect(other.created).toBe(true);
    expect(store.rows.size).toBe(2);
  });

  it('scopes the same key independently by principal', async () => {
    await service.reserve(reserveInput());
    const other = await service.reserve(reserveInput({ principalId: 'user_2' }));

    expect(other.created).toBe(true);
    expect(store.rows.size).toBe(2);
  });

  it('scopes the same key to distinct credential namespaces', async () => {
    const first = await service.reserve(reserveInput({ scope: 'user:same-id' }));
    const second = await service.reserve(reserveInput({ scope: 'apikey:same-id' }));

    expect(first.record.scope).toBe('user:same-id');
    expect(second.record.scope).toBe('apikey:same-id');
    expect(second.created).toBe(true);
    expect(store.rows.size).toBe(2);
  });

  it('creates exactly one reservation for concurrent duplicates', async () => {
    const results = await Promise.all([
      service.reserve(reserveInput()),
      service.reserve(reserveInput()),
      service.reserve(reserveInput()),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.record.id)).size).toBe(1);
    expect(store.rows.size).toBe(1);
  });

  it('enqueues exactly one job for concurrent duplicates', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const results = await Promise.all([
      service.enqueueOnce(reserveInput(), enqueue),
      service.enqueueOnce(reserveInput(), enqueue),
    ]);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.enqueued)).toHaveLength(1);
    expect(results.filter((result) => !result.enqueued)).toHaveLength(1);
  });

  it('rejects reuse of a key with a different request fingerprint', async () => {
    await service.enqueueOnce(reserveInput(), vi.fn().mockResolvedValue(undefined));

    await expect(
      service.enqueueOnce(reserveInput({ requestFingerprint: fingerprint('51') }), vi.fn()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('treats an expired record as reusable', async () => {
    await service.reserve(reserveInput({ expiresAt: new Date(Date.now() - 1) }));
    const fresh = await service.reserve(reserveInput());

    expect(fresh.created).toBe(true);
    expect(store.rows.size).toBe(1);
  });

  it('finalizes the record when asynchronous processing completes', async () => {
    const { record } = await service.reserve(reserveInput());
    await service.attachTransaction(record.id, 'tx_1');

    const count = await service.finalizeTransaction('tx_1', {
      statusCode: 201,
      body: { transaction: { id: 'tx_1' } },
      requestId: 'req-original',
    });

    expect(count).toBe(1);
    const replayed = await service.reserve(reserveInput());
    expect(service.completedResponse(replayed.record)).toMatchObject({
      statusCode: 201,
      requestId: 'req-original',
    });
  });

  it('frees the key after an asynchronous terminal failure', async () => {
    const { record } = await service.reserve(reserveInput());
    await service.attachTransaction(record.id, 'tx_1');
    await service.failTransaction('tx_1');

    expect(store.rows.get(record.id)?.status).toBe('FAILED');

    const retry = await service.reserve(reserveInput());
    expect(retry.created).toBe(true);
  });

  it('deletes expired records', async () => {
    await service.reserve(reserveInput({ expiresAt: new Date(Date.now() - 1) }));

    const result = await service.deleteExpired();

    expect(result.count).toBe(1);
    expect(store.rows.size).toBe(0);
  });
});
