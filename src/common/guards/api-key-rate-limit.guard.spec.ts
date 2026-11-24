import { describe, it, expect, vi } from 'vitest';
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ApiKeyRateLimitGuard, ApiKeyRateLimitStore } from './api-key-rate-limit.guard';

function makeContext(ip: string, apiKey?: string, setHeader = vi.fn()): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        ip,
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      }),
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyRateLimitGuard (#413)', () => {
  it('allows requests within configured IP and API key thresholds', async () => {
    const store: ApiKeyRateLimitStore = {
      increment: vi.fn().mockResolvedValue({ count: 2, ttlSeconds: 55 }),
    };
    const guard = new ApiKeyRateLimitGuard(store, {
      windowSeconds: 60,
      maxRequestsPerIp: 10,
      maxRequestsPerApiKey: 20,
    });

    expect(await guard.canActivate(makeContext('10.0.0.1', 'ak_live_1234567890'))).toBe(true);
    expect(store.increment).toHaveBeenCalledTimes(2);
  });

  it('throws HTTP 429 and sets Retry-After header when IP limit is exceeded', async () => {
    const setHeader = vi.fn();
    const store: ApiKeyRateLimitStore = {
      increment: vi.fn().mockResolvedValue({ count: 11, ttlSeconds: 42 }),
    };
    const guard = new ApiKeyRateLimitGuard(store, {
      windowSeconds: 60,
      maxRequestsPerIp: 10,
    });

    await expect(guard.canActivate(makeContext('10.0.0.1', undefined, setHeader))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
  });
});
