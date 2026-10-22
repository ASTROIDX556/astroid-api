import { describe, expect, it, vi } from 'vitest';
import {
  executeRpcWithBackoff,
  isRetryableRpcError,
} from './rpc-retry-client.util';

describe('executeRpcWithBackoff (#307)', () => {
  it('retries transient RPC 429/503 errors with exponential backoff and resolves', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const op = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Rate limit'), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('Gateway'), { status: 503 }))
      .mockResolvedValueOnce({ ledger: 99123 });

    const res = await executeRpcWithBackoff(op, {
      maxAttempts: 3,
      baseDelayMs: 100,
      sleep,
    });

    expect(res).toEqual({ ledger: 99123 });
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it('fails fast without retrying on non-retryable 400 client errors', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const badReq = Object.assign(new Error('Invalid XDR'), { status: 400 });
    const op = vi.fn().mockRejectedValue(badReq);

    await expect(
      executeRpcWithBackoff(op, { maxAttempts: 3, sleep }),
    ).rejects.toThrow('Invalid XDR');
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(isRetryableRpcError(badReq)).toBe(false);
  });
});
