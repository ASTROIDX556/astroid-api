import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { TransactionLockInterceptor } from './transaction-lock.interceptor';
import { RedisLock } from './redis-lock.util';
import { TRANSACTION_LOCK_KEY, TransactionLockOptions } from './transaction-lock.decorator';
import { LockNotAcquiredException } from '../exceptions/domain.exception';

function buildContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => Controller,
  } as unknown as ExecutionContext;
}

const handler = (): void => {};
class Controller {}

function decorate(options: TransactionLockOptions | undefined): void {
  if (options === undefined) {
    Reflect.deleteMetadata(TRANSACTION_LOCK_KEY, handler);
    return;
  }
  Reflect.defineMetadata(TRANSACTION_LOCK_KEY, options, handler);
}

describe('TransactionLockInterceptor', () => {
  let reflector: Reflector;
  let redisLock: { withLock: ReturnType<typeof vi.fn> };
  let interceptor: TransactionLockInterceptor;

  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteMetadata(TRANSACTION_LOCK_KEY, handler);
    reflector = new Reflector();
    redisLock = {
      withLock: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    };
    interceptor = new TransactionLockInterceptor(reflector, redisLock as unknown as RedisLock);
  });

  it('passes through when the handler is not decorated with @UseTransactionLock()', async () => {
    decorate(undefined);
    const ctx = buildContext({ body: { walletId: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    const result = await interceptor.intercept(ctx, next).toPromise();

    expect(result).toBe('ok');
    expect(redisLock.withLock).not.toHaveBeenCalled();
  });

  it('acquires a lock on the default composite wallet key for decorated handlers', async () => {
    decorate({});
    const ctx = buildContext({ body: { walletId: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith(
      'transaction:wallet-1',
      expect.any(Function),
      8000,
      3,
      50,
    );
  });

  it('includes the budget id in the composite lock key when present', async () => {
    decorate({});
    const ctx = buildContext({ body: { walletId: 'wallet-1', budgetId: 'budget-42' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith(
      'transaction:wallet-1:budget-42',
      expect.any(Function),
      8000,
      3,
      50,
    );
  });

  it('omits the budget component when budgetId is absent', async () => {
    decorate({});
    const ctx = buildContext({ body: { walletId: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith(
      'transaction:wallet-1',
      expect.any(Function),
      8000,
      3,
      50,
    );
  });

  it('supports a custom static lock key', async () => {
    decorate({ key: 'transaction:custom' });
    const ctx = buildContext({ body: { walletId: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith(
      'transaction:custom',
      expect.any(Function),
      8000,
      3,
      50,
    );
  });

  it('supports a custom key resolver function receiving the request', async () => {
    const resolver = vi.fn().mockReturnValue('transaction:resolved');
    decorate({ key: resolver });
    const req = { body: { walletId: 'wallet-1' } };
    const ctx = buildContext(req);
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(resolver).toHaveBeenCalledWith(req);
    expect(redisLock.withLock).toHaveBeenCalledWith(
      'transaction:resolved',
      expect.any(Function),
      8000,
      3,
      50,
    );
  });

  it('uses the configured ttl, attempts, and retryDelayMs when provided', async () => {
    decorate({ ttl: 3000, attempts: 5, retryDelayMs: 100 });
    const ctx = buildContext({ body: { walletId: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith(
      'transaction:wallet-1',
      expect.any(Function),
      3000,
      5,
      100,
    );
  });

  it('rejects the request when the wallet id cannot be resolved', async () => {
    decorate({});
    const ctx = buildContext({ body: {} });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await expect(interceptor.intercept(ctx, next).toPromise()).rejects.toThrow('walletId');
    expect(redisLock.withLock).not.toHaveBeenCalled();
  });

  it('propagates lock acquisition failures to the caller', async () => {
    decorate({});
    redisLock.withLock.mockRejectedValue(new LockNotAcquiredException('wallet-1'));
    const ctx = buildContext({ body: { walletId: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await expect(interceptor.intercept(ctx, next).toPromise()).rejects.toBeInstanceOf(
      LockNotAcquiredException,
    );
  });

  it('propagates handler errors through the lock boundary', async () => {
    decorate({});
    const ctx = buildContext({ body: { walletId: 'wallet-1' } });
    const next = { handle: () => throwError(() => new Error('boom')) } as unknown as CallHandler;

    await expect(interceptor.intercept(ctx, next).toPromise()).rejects.toThrow('boom');
    expect(redisLock.withLock).toHaveBeenCalledWith(
      'transaction:wallet-1',
      expect.any(Function),
      8000,
      3,
      50,
    );
  });

  describe('concurrent lock contention', () => {
    it('rejects the second concurrent request for the same wallet', async () => {
      decorate({ attempts: 1 });
      let lockHeld = false;
      redisLock.withLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
        if (lockHeld) {
          throw new LockNotAcquiredException('wallet-1');
        }
        lockHeld = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          return await fn();
        } finally {
          lockHeld = false;
        }
      });

      const ctx = buildContext({ body: { walletId: 'wallet-1' } });

      // Start first request (will hold lock for 50ms)
      const firstPromise = interceptor
        .intercept(ctx, { handle: () => of('first') } as unknown as CallHandler)
        .toPromise();

      // Immediately start second request — should fail because lock is held
      await expect(
        interceptor
          .intercept(ctx, { handle: () => of('second') } as unknown as CallHandler)
          .toPromise(),
      ).rejects.toBeInstanceOf(LockNotAcquiredException);

      // First request should still succeed
      const first = await firstPromise;
      expect(first).toBe('first');
    });

    it('allows requests for different wallets concurrently', async () => {
      decorate({ attempts: 1 });
      const heldWallets = new Set<string>();
      redisLock.withLock.mockImplementation(async (key: string, fn: () => Promise<unknown>) => {
        if (heldWallets.has(key)) {
          throw new LockNotAcquiredException(key);
        }
        heldWallets.add(key);
        try {
          return await fn();
        } finally {
          heldWallets.delete(key);
        }
      });

      const ctx1 = buildContext({ body: { walletId: 'wallet-1' } });
      const ctx2 = buildContext({ body: { walletId: 'wallet-2' } });

      // Both requests should succeed since they target different wallets
      const [first, second] = await Promise.all([
        interceptor
          .intercept(ctx1, { handle: () => of('first') } as unknown as CallHandler)
          .toPromise(),
        interceptor
          .intercept(ctx2, { handle: () => of('second') } as unknown as CallHandler)
          .toPromise(),
      ]);

      expect(first).toBe('first');
      expect(second).toBe('second');
    });

    it('allows requests for the same wallet but different budgets concurrently', async () => {
      decorate({ attempts: 1 });
      const heldKeys = new Set<string>();
      redisLock.withLock.mockImplementation(async (key: string, fn: () => Promise<unknown>) => {
        if (heldKeys.has(key)) {
          throw new LockNotAcquiredException(key);
        }
        heldKeys.add(key);
        try {
          return await fn();
        } finally {
          heldKeys.delete(key);
        }
      });

      const ctx1 = buildContext({ body: { walletId: 'wallet-1', budgetId: 'budget-A' } });
      const ctx2 = buildContext({ body: { walletId: 'wallet-1', budgetId: 'budget-B' } });

      const [first, second] = await Promise.all([
        interceptor
          .intercept(ctx1, { handle: () => of('first') } as unknown as CallHandler)
          .toPromise(),
        interceptor
          .intercept(ctx2, { handle: () => of('second') } as unknown as CallHandler)
          .toPromise(),
      ]);

      expect(first).toBe('first');
      expect(second).toBe('second');
    });

    it('serializes requests for the same wallet AND budget', async () => {
      decorate({ attempts: 1 });
      const heldKeys = new Set<string>();
      redisLock.withLock.mockImplementation(async (key: string, fn: () => Promise<unknown>) => {
        if (heldKeys.has(key)) {
          throw new LockNotAcquiredException(key);
        }
        heldKeys.add(key);
        try {
          return await fn();
        } finally {
          heldKeys.delete(key);
        }
      });

      const ctx = buildContext({ body: { walletId: 'wallet-1', budgetId: 'budget-A' } });

      const firstPromise = interceptor
        .intercept(ctx, { handle: () => of('first') } as unknown as CallHandler)
        .toPromise();

      await expect(
        interceptor
          .intercept(ctx, { handle: () => of('second') } as unknown as CallHandler)
          .toPromise(),
      ).rejects.toBeInstanceOf(LockNotAcquiredException);

      const first = await firstPromise;
      expect(first).toBe('first');
    });
  });
});
