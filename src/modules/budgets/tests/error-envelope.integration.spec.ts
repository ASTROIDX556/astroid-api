import { describe, expect, it, vi } from 'vitest';
import { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { createBudgetSchema } from '../budget.dto';
import {
  BudgetExceededException,
  ConflictException,
} from '../../../common/exceptions/domain.exception';

/**
 * Exercises the real failure chain end-to-end: a thrown budget-domain error →
 * the global AllExceptionsFilter → the canonical envelope
 * `{ success, error: { code, message }, requestId }`. The filter is the exact
 * class registered as APP_FILTER in AppModule, and the pipe is the exact class
 * used by the budget controllers.
 */
describe('budget consumption — error envelopes (real filter + real pipe)', () => {
  function mockHost(requestId = 'req-budget-1') {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const response = { status };
    const request = {
      headers: { 'x-request-id': requestId },
      method: 'POST',
      url: '/budgets',
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as unknown as ArgumentsHost;
    return { json, status, host };
  }

  function prismaError(code: string) {
    return new Prisma.PrismaClientKnownRequestError('db failed', {
      code,
      clientVersion: '5.22.0',
    });
  }

  const filter = new AllExceptionsFilter();

  it('maps BudgetExceededException to a 422 BUDGET_EXCEEDED envelope', () => {
    const { json, status, host } = mockHost();
    const details = {
      budgetId: 'budget-1',
      limit: '1000.0000000',
      spent: '950.0000000',
      attempted: 100,
    };

    filter.catch(new BudgetExceededException('Transaction would exceed the budget limit', details), host);

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'BUDGET_EXCEEDED', message: 'Transaction would exceed the budget limit', details },
      requestId: 'req-budget-1',
    });
  });

  it('maps ConflictException to a 409 CONFLICT envelope', () => {
    const { json, status, host } = mockHost('req-budget-2');

    filter.catch(new ConflictException('Budget not found'), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'CONFLICT', message: 'Budget not found' },
      requestId: 'req-budget-2',
    });
  });

  it('maps a Zod validation failure into a 422 VALIDATION_ERROR envelope', () => {
    const { json, status, host } = mockHost('req-budget-3');
    const pipe = new ZodValidationPipe(createBudgetSchema);

    // 8 decimal places exceed the platform's 7-dp precision limit.
    let thrown: unknown;
    try {
      pipe.transform({ name: 'Q3', limitAmount: '1000.00000001' }, {} as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();

    filter.catch(thrown, host);

    expect(status).toHaveBeenCalledWith(422);
    const body = json.mock.calls[0][0] as {
      success: boolean;
      error: { code: string; details: Array<{ path: string }> };
      requestId: string;
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'limitAmount' })]),
    );
    expect(body.requestId).toBe('req-budget-3');
  });

  it('maps Prisma P2002 (unique violation) to a 409 CONFLICT envelope', () => {
    const { json, status, host } = mockHost('req-budget-4');

    filter.catch(prismaError('P2002'), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'CONFLICT',
        message: 'A resource with these unique attributes already exists',
      },
      requestId: 'req-budget-4',
    });
  });

  it('maps Prisma P2025 (record not found) to a 404 NOT_FOUND envelope', () => {
    const { json, status, host } = mockHost('req-budget-5');

    filter.catch(prismaError('P2025'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
      requestId: 'req-budget-5',
    });
  });

  it('maps unknown Prisma codes (e.g. P1000) to a typed 400 envelope, never leaking the raw error', () => {
    const { json, status, host } = mockHost('req-budget-6');

    filter.catch(prismaError('P1000'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Database request could not be processed' },
      requestId: 'req-budget-6',
    });
  });
});
