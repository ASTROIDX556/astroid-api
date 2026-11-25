import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INestApplication, Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { NextFunction, Request, Response } from 'express';

import { AuditController } from '../../modules/audit/audit.controller';
import { AuditService } from '../../modules/audit/audit.service';
import { AuditArchiveService } from '../../modules/audit/audit-archive.service';
import { TransactionController } from '../../modules/transactions/transaction.controller';
import { TransactionService } from '../../modules/transactions/transaction.service';
import { WebhookController } from '../../modules/webhooks/webhook.controller';
import { WebhookService } from '../../modules/webhooks/webhook.service';
import { AllExceptionsFilter } from '../filters/all-exceptions.filter';
import { ResponseInterceptor } from '../interceptors/response.interceptor';
import { AgentThrottlerGuard } from '../guards/agent-throttler.guard';
import { SlidingWindowThrottlerGuard } from '../guards/sliding-window-throttler.guard';
import { SensitiveRateLimitGuard } from '../guards/sensitive-rate-limit.guard';
import { SpendingLimitGuard } from '../../modules/transactions/guards/spending-limit.guard';
import { AgentBudgetGuard } from '../../modules/budgets/guards/agent-budget.guard';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { CursorPaginated } from '../interfaces/api-response.interface';
import { decodeCursor, encodeCursor } from './cursor-pagination';

/**
 * End-to-end check of the cursor pagination contract on the three list
 * endpoints touched by the pagination work: the audit history, the transaction
 * history and the webhook delivery log.
 *
 * Each test drives the real controller over HTTP, so the query is parsed by the
 * real Zod pipe (400 on an invalid cursor or limit), the result passes through
 * the shared envelope interceptor, and errors are rendered by the global
 * exception filter. The services are replaced by an in-memory keyset page over
 * five rows that honours the opaque cursor exactly like the repositories do.
 */

type Row = { id: string; createdAt: Date };

/** Newest first, newest-first ordering identical to the repository queries. */
const ROWS: Row[] = [4, 3, 2, 1, 0].map((n) => ({
  id: `row-${n}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
}));

function page(rows: Row[], limit: number, cursor?: string): CursorPaginated<Row> {
  const start = cursor ? rows.findIndex((row) => encodeCursor(row) === cursor) + 1 : 0;
  const slice = rows.slice(start, start + limit + 1);
  const hasMore = slice.length > limit;
  const items = hasMore ? slice.slice(0, limit) : slice;
  const last = items[items.length - 1];
  return new CursorPaginated(items, {
    limit,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  });
}

@Module({})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((request: Request, _response: Response, next: NextFunction) => {
        // The JWT strategy normally populates the principal.
        (request as Request & { user?: unknown }).user = {
          id: 'user-1',
          organizationId: 'org-1',
          email: 'owner@example.com',
          role: 'OWNER',
        };
        next();
      })
      .forRoutes('*');
  }
}

type ListBody = {
  success: boolean;
  data: Row[];
  meta: { limit: number; hasMore: boolean; nextCursor: string | null };
  requestId: string;
};

type ProblemBody = { status: number; code: string; details?: unknown };

describe('Cursor pagination endpoints', () => {
  let app: INestApplication;
  let baseUrl: string;
  let auditList: ReturnType<typeof vi.fn>;
  let transactionList: ReturnType<typeof vi.fn>;
  let deliveryList: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    auditList = vi.fn((_organizationId: string, query: { limit: number; cursor?: string }) =>
      page(ROWS, query.limit, query.cursor),
    );
    transactionList = vi.fn(
      (_organizationId: string, query: { limit: number; cursor?: string }) =>
        page(ROWS, query.limit, query.cursor),
    );
    deliveryList = vi.fn(
      (_organizationId: string, query: { limit: number; cursor?: string }) =>
        page(ROWS, query.limit, query.cursor),
    );

    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
      controllers: [AuditController, TransactionController, WebhookController],
      providers: [
        { provide: AuditService, useValue: { list: auditList } },
        { provide: AuditArchiveService, useValue: {} },
        { provide: TransactionService, useValue: { list: transactionList } },
        { provide: WebhookService, useValue: { listDeliveries: deliveryList } },
        // The controllers register IdempotencyInterceptor, which needs the
        // shared service; these list routes never send an Idempotency-Key, so
        // the engine is replaced with an inert stub.
        {
          provide: IdempotencyService,
          useValue: {
            begin: vi.fn(async () => {
              throw new Error('idempotency is not exercised by the list routes');
            }),
          },
        },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    })
      // Rate limiting and spending checks are out of scope here and would pull
      // in Redis and the budget pipeline; only the list routes are exercised.
      .overrideGuard(AgentThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SlidingWindowThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SpendingLimitGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AgentBudgetGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SensitiveRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/api/v1`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    auditList.mockClear();
    transactionList.mockClear();
    deliveryList.mockClear();
  });

  async function get(path: string) {
    const response = await fetch(`${baseUrl}${path}`);
    return { response, body: (await response.json()) as ListBody & ProblemBody };
  }

  const endpoints = [
    { name: 'GET /audit', path: '/audit', service: () => auditList },
    { name: 'GET /transactions', path: '/transactions', service: () => transactionList },
    {
      name: 'GET /webhooks/deliveries',
      path: '/webhooks/deliveries',
      service: () => deliveryList,
    },
  ];

  describe.each(endpoints)('$name', ({ path, service }) => {
    it('returns the first page with an opaque next cursor', async () => {
      const { response, body } = await get(`${path}?limit=2`);

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.map((row) => row.id)).toEqual(['row-4', 'row-3']);
      expect(body.meta.limit).toBe(2);
      expect(body.meta.hasMore).toBe(true);
      expect(body.meta.nextCursor).toEqual(expect.any(String));
      expect(body.meta.nextCursor).not.toContain('row-3');
      expect(decodeCursor(body.meta.nextCursor!).id).toBe('row-3');
      expect(service()).toHaveBeenCalledWith('org-1', expect.objectContaining({ limit: 2 }));
    });

    it('follows nextCursor to the next page without repeating rows', async () => {
      const first = await get(`${path}?limit=2`);
      const { response, body } = await get(
        `${path}?limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor!)}`,
      );

      expect(response.status).toBe(200);
      expect(body.data.map((row) => row.id)).toEqual(['row-2', 'row-1']);
      expect(body.meta.hasMore).toBe(true);
      expect(service()).toHaveBeenLastCalledWith(
        'org-1',
        expect.objectContaining({ limit: 2, cursor: first.body.meta.nextCursor }),
      );
    });

    it('reports hasMore false and a null cursor on the last page', async () => {
      const { response, body } = await get(`${path}?limit=10`);

      expect(response.status).toBe(200);
      expect(body.data).toHaveLength(ROWS.length);
      expect(body.meta).toEqual({ limit: 10, hasMore: false, nextCursor: null });
    });

    it('rejects a malformed cursor with 400 instead of an empty page', async () => {
      const { response, body } = await get(`${path}?cursor=not-a-real-cursor`);

      expect(response.status).toBe(400);
      expect(body.status).toBe(400);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(service()).not.toHaveBeenCalled();
    });

    it.each(['0', '101', 'ten'])('rejects limit=%s with 400', async (limit) => {
      const { response, body } = await get(`${path}?limit=${limit}`);

      expect(response.status).toBe(400);
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(service()).not.toHaveBeenCalled();
    });
  });
});
