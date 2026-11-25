import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTransientNetworkError, retryWithBackoff } from './retry.util';

vi.mock('./backoff.util', () => ({
  exponentialBackoffWithJitter: vi.fn().mockReturnValue(10),
}));

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns the result on the first successful attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryWithBackoff(fn, { maxAttempts: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds on the second attempt', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting all attempts', async () => {
    const boom = new Error('persistent failure');
    const fn = vi.fn().mockRejectedValue(boom);

    const promise = retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 10 });
    // Attach a handler immediately so the rejection isn't flagged as unhandled
    // while `runAllTimersAsync` drives the retry loop forward below.
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops retrying immediately when isRetryable returns false', async () => {
    const nonRetryable = new Error('NOT NULL constraint failed');
    const fn = vi.fn().mockRejectedValue(nonRetryable);
    const isRetryable = (err: unknown) =>
      !(err instanceof Error && err.message.includes('NOT NULL'));

    const promise = retryWithBackoff(fn, { maxAttempts: 5, isRetryable });
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(nonRetryable);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry before each retry sleep', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('t1'))
      .mockRejectedValueOnce(new Error('t2'))
      .mockResolvedValue('ok');

    const promise = retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 10, onRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1);
    expect(onRetry.mock.calls[1][0]).toBe(2);
  });

  it('caps the delay at maxDelayMs', async () => {
    const { exponentialBackoffWithJitter } = await import('./backoff.util');
    (exponentialBackoffWithJitter as ReturnType<typeof vi.fn>).mockReturnValue(60_000);

    const fn = vi.fn().mockRejectedValueOnce(new Error('t')).mockResolvedValue('ok');

    const onRetry = vi.fn();
    const promise = retryWithBackoff(fn, {
      maxAttempts: 2,
      maxDelayMs: 5_000,
      onRetry,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 5_000);
  });

  it('does not sleep on the last attempt before throwing', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const onRetry = vi.fn();

    const promise = retryWithBackoff(fn, { maxAttempts: 2, baseDelayMs: 10, onRetry });
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow();

    // onRetry is called before sleeping: once after attempt 1, not after attempt 2.
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('isTransientNetworkError', () => {
  it('classifies 5xx responses as transient', () => {
    expect(isTransientNetworkError(Object.assign(new Error('Bad Gateway'), { status: 502 }))).toBe(true);
    expect(
      isTransientNetworkError(Object.assign(new Error('Service Unavailable'), { statusCode: 503 })),
    ).toBe(true);
  });

  it('classifies 4xx responses as non-transient so they fail fast', () => {
    expect(isTransientNetworkError(Object.assign(new Error('Bad Request'), { status: 400 }))).toBe(false);
    expect(isTransientNetworkError(Object.assign(new Error('Not Found'), { status: 404 }))).toBe(false);
  });

  it('classifies transport-level network errors as transient', () => {
    expect(isTransientNetworkError(Object.assign(new Error('Connection reset by peer'), { code: 'ECONNRESET' }))).toBe(
      true,
    );
    expect(isTransientNetworkError(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }))).toBe(
      true,
    );
    expect(
      isTransientNetworkError(
        Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), {
          cause: Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe(true);
  });

  it('does not retry deterministic errors that carry no transient signals', () => {
    expect(isTransientNetworkError(new Error('NOT NULL constraint failed'))).toBe(false);
  });

  it('does not retry errors explicitly marked as permanent', () => {
    expect(isTransientNetworkError(Object.assign(new Error('Invalid GraphQL query'), { retryable: false }))).toBe(
      false,
    );
  });

  it('reads the status through getStatus when plain fields are absent', () => {
    expect(isTransientNetworkError({ getStatus: () => 400, message: 'Bad Request' })).toBe(false);
    expect(isTransientNetworkError({ getStatus: () => 503, message: 'Service Unavailable' })).toBe(true);
  });
});
