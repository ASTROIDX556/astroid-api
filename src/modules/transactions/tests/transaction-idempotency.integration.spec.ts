import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdempotencyRecord } from '@prisma/client';
import { from, lastValueFrom, Observable } from 'rxjs';

import { IDEMPOTENT_KEY } from '../../../common/decorators/idempotent.decorator';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { IdempotencyInterceptor } from '../../../common/interceptors/idempotency.interceptor';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';
import { PrismaService } from '../../../database/prisma.service';
import { TransactionController } from '../transaction.controller';
import { TransactionService } from '../transaction.service';

/**
 * In-memory `idempotency_records` table. It enforces the same
 * `(principalId, route, keyHash)` uniqueness as the database constraint, so the
 * production IdempotencyService runs against it unchanged.
 */
function createPrisma() {
  const rows = new Map<string, IdempotencyRecord>();
  let sequence = 0;

  const matchesIdentity = (row: IdempotencyRecord, where: Record<string, unknown>) =>
    (typeof where.principalId !== 'string' || row.principalId === where.principalId) &&
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
              row.principalId === data.principalId &&
              row.route === data.route &&
              row.keyHash === data.keyHash,
          );
          if (duplicate) throw { code: 'P2002' };
          const row: IdempotencyRecord = {
            id: `idempotency_${(sequence += 1)}`,
            principalId: data.principalId as string,
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
          const identity = where.principalId_route_keyHash as Record<string, unknown>;
          return [...rows.values()].find((row) => matchesIdentity(row, identity)) ?? null;
        }),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = rows.get(where.id);
            if (!row) throw new Error(`missing idempotency record ${where.id}`);
            const updated = { ...row, ...data } as IdempotencyRecord;
            rows.set(row.id, updated);
            return updated;
          },
        ),
      },
    } as unknown as PrismaService,
  };
}

const USER: AuthenticatedUser = {
  id: 'user_1',
  organizationId: 'org_1',
  role: 'ADMIN' as never,
};

const BODY = { agentId: 'agent_1', amount: '10' };

interface ApiResponse {
  statusCode: number;
  status: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  getHeader: ReturnType<typeof vi.fn>;
  headers: Record<string, string>;
}

describe('POST /transactions idempotency', () => {
  let store: ReturnType<typeof createPrisma>;
  let interceptor: IdempotencyInterceptor;
  let responseInterceptor: ResponseInterceptor<unknown>;
  let controller: TransactionController;
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createPrisma();
    const reflector = new Reflector();
    interceptor = new IdempotencyInterceptor(
      reflector,
      new IdempotencyService(store.prisma),
    );
    responseInterceptor = new ResponseInterceptor<unknown>();
    create = vi.fn().mockResolvedValue({
      transaction: { id: 'tx_1', amount: '10' },
      requiresApproval: false,
      risk: { score: 5 },
    });
    const service = { create } as unknown as TransactionService;
    controller = new TransactionController(service);
  });

  function makeContext(request: Record<string, unknown>, response: ApiResponse): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
      getHandler: () => TransactionController.prototype.create,
      getClass: () => TransactionController,
    } as unknown as ExecutionContext;
  }

  function makeResponse(): ApiResponse {
    const headers: Record<string, string> = {};
    return {
      statusCode: 201,
      headers,
      status: vi.fn(),
      setHeader: vi.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      getHeader: vi.fn((name: string) => headers[name]),
    };
  }

  /** Runs the real route-level idempotency interceptor + global envelope. */
  async function submit(idempotencyKey: string, requestId: string, body = BODY) {
    const request = {
      headers: { 'idempotency-key': idempotencyKey, 'x-request-id': requestId },
      body,
      user: USER,
      method: 'POST',
      path: '/transactions',
    };
    const response = makeResponse();
    // The request-id middleware stamps the response before interceptors run.
    response.headers['x-request-id'] = requestId;
    const context = makeContext(request, response);
    const handler: CallHandler<unknown> = {
      handle: () => from(controller.create(USER, body as never)),
    };

    const idempotent$ = (await interceptor.intercept(context, handler)) as Observable<unknown>;
    const envelope$ = responseInterceptor.intercept(context, { handle: () => idempotent$ });
    return { body: await lastValueFrom(envelope$), response };
  }

  it('is guarded by the @Idempotent() decorator', () => {
    expect(
      Reflect.getMetadata(IDEMPOTENT_KEY, TransactionController.prototype.create),
    ).toBeDefined();
  });

  it('enqueues one transaction, stores one record and replays identical data', async () => {
    const first = await submit('order-42', 'req_1');
    const second = await submit('order-42', 'req_2');

    expect(create).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(1);

    expect(first.body).toMatchObject({
      success: true,
      data: { transaction: { id: 'tx_1', amount: '10' }, requiresApproval: false },
      meta: {},
      requestId: 'req_1',
    });
    // A replay returns the original request id and status, not the duplicate's.
    expect(second.body).toMatchObject({
      success: true,
      data: (first.body as { data: unknown }).data,
      meta: {},
      requestId: 'req_1',
    });
    expect(second.response.status).toHaveBeenCalledWith(201);
    expect(second.response.statusCode).toBe(201);
  });

  it('answers 409 without enqueuing when the same key carries a different body', async () => {
    await submit('order-42', 'req_1');

    const error: unknown = await submit('order-42', 'req_2', { ...BODY, amount: '99' }).catch(
      (reason: unknown) => reason,
    );
    expect((error as { getStatus?: () => number }).getStatus?.()).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(1);
  });

  it('scopes the same key independently per route', async () => {
    await submit('order-42', 'req_1');

    // Same principal and key, different route: a separate record is created.
    const service = new IdempotencyService(store.prisma);
    const reservation = await service.begin({
      principalId: USER.id,
      route: 'POST /transactions/execute',
      key: 'order-42',
      requestBody: BODY,
    });

    expect(reservation.replay).toBeUndefined();
    expect(store.rows.size).toBe(2);
  });
});
