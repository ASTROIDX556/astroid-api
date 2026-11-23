import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { Budget, Prisma } from '@prisma/client';
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
import { ZodValidationExceptionFilter } from '../../common/filters/zod-validation-exception.filter';
import { PrismaExceptionFilter } from '../../common/filters/prisma-exception.filter';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { ErrorCode } from '../../common/constants/error-codes';
import { RedisLock } from '../../common/locks/redis-lock.util';
import { PrismaService } from '../../database/prisma.service';
import { EventBusService } from '../../events/event-bus.service';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { BudgetRepository, BudgetReservationError } from '../budgets/budget.repository';
import { BudgetService } from '../budgets/budget.service';
import { BudgetRolloverService } from '../budgets/services/budget-rollover.service';

/**
 * POST /transactions over real HTTP when the budget reservation is refused.
 * The real BudgetService turns the repository's `BudgetExceeded` outcome into
 * its domain error, and the exception filters — registered exactly as in
 * app.module.ts — must render it as the standard 422 error envelope, never a
 * 500.
 */
describe('POST /transactions when the budget is exhausted', () => {
  let app: INestApplication;
  let baseUrl: string;
  let createReservation: ReturnType<typeof vi.fn>;

  const principal: AuthenticatedUser = {
    id: 'user-1',
    organizationId: 'org-1',
    role: 'OWNER' as AuthenticatedUser['role'],
  };
  const authenticate: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user = principal;
      return true;
    },
  };

  beforeAll(async () => {
    createReservation = vi.fn().mockRejectedValue(new BudgetReservationError('BudgetExceeded'));
    const repository = {
      createReservation,
      findById: vi.fn().mockResolvedValue({
        id: 'budget-1',
        limitAmount: new Prisma.Decimal(100),
        spent: new Prisma.Decimal(80),
      } as unknown as Budget),
    } as unknown as BudgetRepository;
    const budgets = new BudgetService(
      repository,
      { emit: vi.fn().mockResolvedValue(undefined) } as unknown as EventBusService,
      {} as unknown as RedisLock,
      {} as unknown as BudgetRolloverService,
    );
    // The creation pipeline reserves the budget before anything else is stored.
    const transactionService = {
      create: vi.fn(async (organizationId: string, _actor: string, body: { amount: string; budgetId: string }) =>
        budgets.reserveAtomic(organizationId, body.budgetId, Number(body.amount))),
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
        { provide: IdempotencyService, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: TransactionService, useValue: transactionService },
        { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
        { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
        // Same filters, same order as app.module.ts.
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
        { provide: APP_FILTER, useClass: ZodValidationExceptionFilter },
        { provide: APP_FILTER, useClass: PrismaExceptionFilter },
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

  afterAll(async () => {
    await app.close();
  });

  it('answers 422 with the standard BUDGET_EXCEEDED error envelope', async () => {
    const res = await fetch(`${baseUrl}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-budget-1' },
      body: JSON.stringify({
        walletId: '550e8400-e29b-41d4-a716-446655440000',
        recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
        asset: 'XLM',
        amount: '40',
        budgetId: '018f0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(422);
    // The same envelope as every other domain error, e.g. POLICY_VIOLATION.
    expect(body).toEqual({
      success: false,
      error: {
        code: ErrorCode.BUDGET_EXCEEDED,
        message: 'Transaction would exceed the budget limit',
      },
      meta: { requestId: 'req-budget-1' },
    });
    expect(createReservation).toHaveBeenCalledTimes(1);
  });
});
