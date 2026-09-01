import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { WalletLockInterceptor } from './wallet-lock.interceptor';
import { RedisLock } from './redis-lock.util';
import { WALLET_LOCK_KEY, WalletLockOptions } from './wallet-lock.decorator';
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

function decorate(options: WalletLockOptions | undefined): void {
  if (options === undefined) {
    Reflect.deleteMetadata(WALLET_LOCK_KEY, handler);
    return;
  }
  Reflect.defineMetadata(WALLET_LOCK_KEY, options, handler);
}

describe('WalletLockInterceptor', () => {
  let reflector: Reflector;
  let redisLock: { withLock: ReturnType<typeof vi.fn> };
  let interceptor: WalletLockInterceptor;

  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteMetadata(WALLET_LOCK_KEY, handler);
    reflector = new Reflector();
    redisLock = {
      withLock: vi.fn().mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn()),
    };
    interceptor = new WalletLockInterceptor(reflector, redisLock as unknown as RedisLock);
  });

  it('passes through when the handler is not decorated with @UseWalletLock()', async () => {
    decorate(undefined);
    const ctx = buildContext({ params: { id: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    const result = await interceptor.intercept(ctx, next).toPromise();

    expect(result).toBe('ok');
    expect(redisLock.withLock).not.toHaveBeenCalled();
  });

  it('acquires a lock on the default wallet key for decorated handlers', async () => {
    decorate({});
    const ctx = buildContext({ params: { id: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith('wallet:wallet-1', expect.any(Function), 5000);
  });

  it('supports a custom static lock key', async () => {
    decorate({ key: 'wallet:custom' });
    const ctx = buildContext({ params: { id: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith('wallet:custom', expect.any(Function), 5000);
  });

  it('supports a custom key resolver function receiving the request', async () => {
    const resolver = vi.fn().mockReturnValue('wallet:resolved');
    decorate({ key: resolver });
    const req = { params: { id: 'wallet-1' } };
    const ctx = buildContext(req);
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(resolver).toHaveBeenCalledWith(req);
    expect(redisLock.withLock).toHaveBeenCalledWith('wallet:resolved', expect.any(Function), 5000);
  });

  it('falls back to body.walletId when no route param is present', async () => {
    decorate({});
    const ctx = buildContext({ params: {}, body: { walletId: 'wallet-9' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith('wallet:wallet-9', expect.any(Function), 5000);
  });

  it('uses the configured ttl when provided', async () => {
    decorate({ ttl: 250 });
    const ctx = buildContext({ params: { id: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await interceptor.intercept(ctx, next).toPromise();

    expect(redisLock.withLock).toHaveBeenCalledWith('wallet:wallet-1', expect.any(Function), 250);
  });

  it('rejects the request when the wallet id cannot be resolved', async () => {
    decorate({});
    const ctx = buildContext({ params: {}, body: {} });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await expect(interceptor.intercept(ctx, next).toPromise()).rejects.toThrow('wallet id');
    expect(redisLock.withLock).not.toHaveBeenCalled();
  });

  it('propagates lock acquisition failures to the caller', async () => {
    decorate({});
    redisLock.withLock.mockRejectedValue(new LockNotAcquiredException('wallet-1'));
    const ctx = buildContext({ params: { id: 'wallet-1' } });
    const next = { handle: () => of('ok') } as unknown as CallHandler;

    await expect(interceptor.intercept(ctx, next).toPromise()).rejects.toBeInstanceOf(
      LockNotAcquiredException,
    );
  });

  it('propagates handler errors through the lock boundary', async () => {
    decorate({});
    const ctx = buildContext({ params: { id: 'wallet-1' } });
    const next = { handle: () => throwError(() => new Error('boom')) } as unknown as CallHandler;

    await expect(interceptor.intercept(ctx, next).toPromise()).rejects.toThrow('boom');
    expect(redisLock.withLock).toHaveBeenCalledWith('wallet:wallet-1', expect.any(Function), 5000);
  });

  describe('concurrent lock acquisition', () => {
    it('rejects the second concurrent request when the lock is already held', async () => {
      decorate({});
      let lockHeld = false;
      redisLock.withLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
        if (lockHeld) {
          throw new LockNotAcquiredException('wallet-1');
        }
        lockHeld = true;
        try {
          return await fn();
        } finally {
          lockHeld = false;
        }
      });

      const ctx = buildContext({ params: { id: 'wallet-1' } });

      // First request acquires the lock
      const firstResult = interceptor.intercept(ctx, { handle: () => of('first') } as unknown as CallHandler);
      await firstResult.toPromise();
      expect(lockHeld).toBe(false); // released after completion

      // Second request succeeds after release
      const secondResult = interceptor.intercept(ctx, { handle: () => of('second') } as unknown as CallHandler);
      const result = await secondResult.toPromise();
      expect(result).toBe('second');
    });

    it('rejects concurrent requests that overlap in time', async () => {
      decorate({ ttl: 100 });
      let lockHeld = false;
      redisLock.withLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
        if (lockHeld) {
          throw new LockNotAcquiredException('wallet-1');
        }
        lockHeld = true;
        // Simulate a slow handler
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          return await fn();
        } finally {
          lockHeld = false;
        }
      });

      const ctx = buildContext({ params: { id: 'wallet-1' } });

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
  });
});
