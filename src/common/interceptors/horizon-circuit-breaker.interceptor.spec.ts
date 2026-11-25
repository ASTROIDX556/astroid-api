import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { lastValueFrom } from 'rxjs';
import {
  HorizonCircuitBreakerInterceptor,
  HORIZON_FALLBACK_KEY,
} from './horizon-circuit-breaker.interceptor';
import {
  HorizonCircuitBreakerService,
  FallbackStrategy,
} from '../../integrations/stellar/horizon-circuit-breaker.service';
import { CircuitOpenException } from '../exceptions/domain.exception';

function buildMockContext(
  overrides: {
    controllerName?: string;
    methodName?: string;
  } = {},
): ExecutionContext {
  const handlerFn = vi.fn();
  // Use Object.defineProperty to handle read-only `name` on function prototype
  Object.defineProperty(handlerFn, 'name', { value: overrides.methodName ?? 'getBalances' });

  const classFn = vi.fn();
  Object.defineProperty(classFn, 'name', { value: overrides.controllerName ?? 'StellarController' });

  return {
    switchToHttp: () => ({
      getRequest: () => ({
        path: '/stellar/balances/GADDR',
        method: 'GET',
        headers: {},
        user: { id: 'user-1', organizationId: 'org-1' },
      }),
    }),
    getHandler: () => handlerFn,
    getClass: () => classFn,
  } as unknown as ExecutionContext;
}

function buildCallHandler(returnValue: unknown = { balance: '100' }): CallHandler {
  return { handle: () => of(returnValue) };
}

function buildErrorCallHandler(error: Error): CallHandler {
  return { handle: () => throwError(() => error) };
}

describe('HorizonCircuitBreakerInterceptor', () => {
  let mockCbService: {
    getName: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    getFailureCount: ReturnType<typeof vi.fn>;
  };
  let interceptor: HorizonCircuitBreakerInterceptor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCbService = {
      getName: vi.fn().mockReturnValue('horizon'),
      getState: vi.fn().mockReturnValue('CLOSED'),
      getFailureCount: vi.fn().mockReturnValue(0),
    };
    interceptor = new HorizonCircuitBreakerInterceptor(
      mockCbService as unknown as HorizonCircuitBreakerService,
    );
  });

  it('passes through successful handler calls without interference', async () => {
    const ctx = buildMockContext();
    const next = buildCallHandler({ balance: '100' });

    const result = await lastValueFrom(interceptor.intercept(ctx, next));

    expect(result).toEqual({ balance: '100' });
  });

  it('passes through non-circuit-breaker errors unchanged', async () => {
    const ctx = buildMockContext();
    const error = new Error('some other error');
    const next = buildErrorCallHandler(error);

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toThrow(
      'some other error',
    );
  });

  it('re-throws CircuitOpenException when no fallback is registered', async () => {
    const ctx = buildMockContext();
    const circuitError = new CircuitOpenException('horizon', 15_000);
    const next = buildErrorCallHandler(circuitError);

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toThrow(
      CircuitOpenException,
    );
  });

  it('invokes method-level fallback when CircuitOpenException is caught', async () => {
    const ctx = buildMockContext();
    const circuitError = new CircuitOpenException('horizon', 15_000);

    // Set metadata on the handler
    const handler = ctx.getHandler();
    const fallback: FallbackStrategy = {
      name: 'cached-balance',
      execute: () => ({ balance: 'stale', isFallback: false }),
    };
    Reflect.defineMetadata(HORIZON_FALLBACK_KEY, fallback, handler);

    const next = buildErrorCallHandler(circuitError);

    const result = await lastValueFrom(interceptor.intercept(ctx, next));

    expect(result).toMatchObject({
      isFallback: true,
      circuitName: 'horizon',
      cachedData: { balance: 'stale', isFallback: false },
      retryAfterMs: 0,
      timestamp: expect.any(Number),
    });
  });

  it('derives operation name from controller and handler names', async () => {
    const ctx = buildMockContext({
      controllerName: 'StellarController',
      methodName: 'getBalances',
    });
    const next = buildCallHandler();

    // The interceptor should not throw for successful calls
    const result = await lastValueFrom(interceptor.intercept(ctx, next));
    expect(result).toBeDefined();
  });

  it('returns fallback response with correct structure', async () => {
    const ctx = buildMockContext();
    const circuitError = new CircuitOpenException('horizon', 10_000);

    const handler = ctx.getHandler();
    const fallback: FallbackStrategy = {
      name: 'test-fallback',
      execute: () => 'cached-data',
    };
    Reflect.defineMetadata(HORIZON_FALLBACK_KEY, fallback, handler);

    const next = buildErrorCallHandler(circuitError);

    const result = (await lastValueFrom(
      interceptor.intercept(ctx, next),
    )) as Record<string, unknown>;

    expect(result.isFallback).toBe(true);
    expect(result.circuitName).toBe('horizon');
    expect(result.cachedData).toBe('cached-data');
    expect(typeof result.timestamp).toBe('number');
  });

  it('propagates fallback execution errors', async () => {
    const ctx = buildMockContext();
    const circuitError = new CircuitOpenException('horizon', 10_000);

    const handler = ctx.getHandler();
    const brokenFallback: FallbackStrategy = {
      name: 'broken',
      execute: () => {
        throw new Error('cache miss');
      },
    };
    Reflect.defineMetadata(HORIZON_FALLBACK_KEY, brokenFallback, handler);

    const next = buildErrorCallHandler(circuitError);

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toThrow('cache miss');
  });
});
