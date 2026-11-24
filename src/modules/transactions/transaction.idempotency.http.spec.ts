import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { IdempotencyRecord } from '@prisma/client';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { AgentBudgetGuard } from '../budgets/guards/agent-budget.guard';
import { SpendingLimitGuard } from './guards/spending-limit.guard';
import { AgentThrottlerGuard } from '../../common/guards/agent-throttler.guard';
import { SlidingWindowThrottlerGuard } from '../../common/guards/sliding-window-throttler.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { RequestContextInterceptor } from '../../common/interceptors/request-context.interceptor';
import { GlobalExceptionFilter } from '../../common/filters/global-exception.filter';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { ErrorCode } from '../../common/constants/error-codes';
import { IDEMPOTENT_REPLAY_HEADER } from '../../common/constants/headers';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';

/**
 * Minimal in-memory implementation of the idempotency table. It enforces the
 * same (scope, route, keyHash) uniqueness as the Prisma migration so replay,
 * divergence and concurrency can be exercised over real HTTP routes.
 */
function createIdempotencyStore() {
  const rows = new Map<string, IdempotencyRecord>();
  let sequence = 0;

  const matches = (row: IdempotencyRecord, where: Record<string, unknown>) =>
    (typeof where.id !== 'string' || row.id === where.id) &&
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
            const expires = where.expiresAt as { lte?: Date } | undefined;
            if (!matches(row, where)) continue;
            if (expires?.lte && row.expiresAt.getTime() > expires.lte.getTime()) continue;
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
            scope: data.scope as string,
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
          return [...rows.values()].find((row) => matches(row, identity)) ?? null;
        }),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = rows.get(where.id);
            if (!row) throw new Error('missing record');
            const updated = { ...row, ...data } as IdempotencyRecord;
            rows.set(row.id, updated);
            return updated;
          },
        ),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    },
  };
}

const basePayload = {
  walletId: '550e8400-e29b-41d4-a716-446655440000',
  recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
  asset: 'XLM',
  amount: '50',
};

const principal: AuthenticatedUser = {
  id: 'user-1',
  organizationId: 'org-1',
  role: 'OWNER' as AuthenticatedUser['role'],
};

describe('transaction creation idempotency over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  let currentUser: AuthenticatedUser;
  let created: number;
  const store = createIdempotencyStore();

  const authenticate: CanActivate = {
    canActivate(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
      request.user = currentUser;
      return true;
    },
  };

  beforeAll(async () => {
    const transactionService = {
      create: vi.fn(async (_org: string, _actor: string, body: { amount: string }) => {
        created += 1;
        return { transaction: { id: `tx-${created}`, status: 'COMPLETED', amount: body.amount } };
      }),
      list: vi.fn(),
      getOrThrow: vi.fn(),
      simulate: vi.fn(),
      cancel: vi.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [TransactionController],
      providers: [
        Reflector,
        IdempotencyInterceptor,
        IdempotencyService,
        { provide: PrismaService, useValue: store.prisma },
        { provide: TransactionService, useValue: transactionService },
        { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    })
      .overrideGuard(AgentThrottlerGuard)
      .useValue(authenticate)
      .overrideGuard(SlidingWindowThrottlerGuard)
      .useValue(authenticate)
      .overrideGuard(SpendingLimitGuard)
      .useValue(authenticate)
      .overrideGuard(AgentBudgetGuard)
      .useValue(authenticate)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    store.rows.clear();
    created = 0;
    currentUser = principal;
  });

  afterAll(async () => {
    await app.close();
  });

  function post(key: string | undefined, body: Record<string, unknown> = basePayload, requestId = 'req-1') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-request-id': requestId,
    };
    if (key !== undefined) headers['idempotency-key'] = key;
    return fetch(`${baseUrl}/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('creates on the first call and replays the envelope with a replay header', async () => {
    created = 0;
    currentUser = principal;
    const key = 'integration-replay-1';

    const first = await post(key, basePayload, 'req-original');
    const firstBody = (await first.json()) as { success: boolean; requestId: string; data: { transaction: { id: string } }; meta: Record<string, unknown> };

    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBeNull();
    expect(firstBody).toMatchObject({ success: true, requestId: 'req-original', meta: {} });

    const replay = await post(key, { ...basePayload }, 'req-duplicate');
    const replayBody = (await replay.json()) as typeof firstBody;

    expect(replay.status).toBe(201);
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe('true');
    expect(replayBody.meta).toEqual({ idempotentReplay: true });
    expect(replayBody.requestId).toBe('req-original');
    expect(replayBody.success).toBe(true);
    expect(created).toBe(1);
    expect(store.rows.size).toBe(1);
  });

  it('normalizes the payload through the route schema before fingerprinting', async () => {
    created = 0;
    const key = 'integration-replay-defaults';
    const first = await post(key, basePayload);
    const replay = await post(key, { ...basePayload, metadata: {} });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get(IDEMPOTENT_REPLAY_HEADER)).toBe('true');
    expect(created).toBe(1);
  });

  it('returns 422 with a stable error code for a divergent payload', async () => {
    created = 0;
    const key = 'integration-divergent-1';
    await post(key, basePayload);

    const response = await post(key, { ...basePayload, amount: '51' });
    const body = (await response.json()) as { status: number; code: string };

    expect(response.status).toBe(422);
    expect(body).toMatchObject({ status: 422, code: ErrorCode.IDEMPOTENCY_KEY_MISMATCH });
    expect(created).toBe(1);
  });

  it('creates one transaction row for concurrent duplicate requests', async () => {
    created = 0;
    const key = 'integration-concurrent-1';
    const responses = await Promise.all([post(key), post(key), post(key)]);

    expect(responses.map((response) => response.status).every((status) => status === 201 || status === 409)).toBe(true);
    expect(created).toBe(1);
    expect(store.rows.size).toBe(1);
  });

  it('scopes the same key per credential and rejects invalid keys', async () => {
    created = 0;
    const key = 'integration-scoped-1';
    await post(key);
    currentUser = { ...principal, id: 'user-2' };
    await post(key);

    expect(created).toBe(2);

    currentUser = principal;
    const invalid = await post('short');
    expect(invalid.status).toBe(400);
  });

  it('does not cache a failed first attempt', async () => {
    created = 0;
    const key = 'integration-failed-1';
    const serverError = new Error('downstream failed');
    const transactionService = app.get(TransactionService) as unknown as {
      create: ReturnType<typeof vi.fn>;
    };
    transactionService.create.mockRejectedValueOnce(serverError);

    const failed = await post(key);
    expect(failed.status).toBe(500);

    const retry = await post(key);
    expect(retry.status).toBe(201);
    expect(created).toBe(1);
  });
});
