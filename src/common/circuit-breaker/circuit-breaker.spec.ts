import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitState, isRpcFailure } from './circuit-breaker';
import { CircuitOpenException, DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildBreaker(): CircuitBreaker {
    return new CircuitBreaker({
      name: 'test-breaker',
      failureThreshold: 3,
      resetTimeoutMs: 10_000,
    });
  }

  describe('CLOSED state', () => {
    it('starts CLOSED and allows calls through', async () => {
      const breaker = buildBreaker();
      const operation = vi.fn().mockResolvedValue('ok');

      const result = await breaker.execute(operation);

      expect(result).toBe('ok');
      expect(operation).toHaveBeenCalledTimes(1);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('resets the failure count after a success', async () => {
      const breaker = buildBreaker();
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce('ok');

      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      await breaker.execute(operation);

      expect(breaker.getFailureCount()).toBe(0);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('propagates the original error on a genuine failure (not a circuit-open error)', async () => {
      const breaker = buildBreaker();
      const operation = vi.fn().mockRejectedValue(new Error('upstream exploded'));

      await expect(breaker.execute(operation)).rejects.toThrow('upstream exploded');
    });
  });

  describe('CLOSED -> OPEN transition', () => {
    it('trips OPEN after `failureThreshold` consecutive failures', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 3,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));

      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      await expect(breaker.execute(operation)).rejects.toThrow('boom');

      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('emits an "open" event with a structured payload when it trips', async () => {
      const breaker = new CircuitBreaker({
        name: 'horizon',
        failureThreshold: 2,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      const onOpen = vi.fn();
      breaker.on('open', onOpen);

      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      await expect(breaker.execute(operation)).rejects.toThrow('boom');

      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'horizon',
          state: CircuitState.OPEN,
          failureCount: 2,
          timestamp: expect.any(Number),
        }),
      );
    });
  });

  describe('OPEN state (fail fast)', () => {
    async function openBreaker(breaker: CircuitBreaker, operation: ReturnType<typeof vi.fn>) {
      await expect(breaker.execute(operation)).rejects.toThrow();
      await expect(breaker.execute(operation)).rejects.toThrow();
      await expect(breaker.execute(operation)).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    }

    it('does not invoke the operation at all while OPEN and before resetTimeoutMs elapses', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 3,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      await openBreaker(breaker, operation);

      operation.mockClear();
      await expect(breaker.execute(operation)).rejects.toThrow(CircuitOpenException);

      expect(operation).not.toHaveBeenCalled();
    });

    it('throws a CircuitOpenException with structured details when no fallback is given', async () => {
      const breaker = new CircuitBreaker({
        name: 'horizon',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      operation.mockClear();
      let thrown: unknown;
      try {
        await breaker.execute(operation);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CircuitOpenException);
      expect(thrown).toBeInstanceOf(DomainException);
      const exception = thrown as CircuitOpenException;
      expect(exception.code).toBe(ErrorCode.CIRCUIT_OPEN);
      expect(exception.details).toMatchObject({
        integration: 'horizon',
        state: 'OPEN',
        retryAfterMs: expect.any(Number),
      });
      expect(operation).not.toHaveBeenCalled();
    });

    it('invokes the fallback instead of throwing when one is provided', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      operation.mockClear();
      const fallback = vi.fn().mockResolvedValue('fallback-value');
      const result = await breaker.execute(operation, fallback);

      expect(result).toBe('fallback-value');
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(operation).not.toHaveBeenCalled();
    });

    it('supports a synchronous fallback function', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(breaker.execute(operation)).rejects.toThrow('boom');

      operation.mockClear();
      const result = await breaker.execute(operation, () => 'sync-fallback');

      expect(result).toBe('sync-fallback');
      expect(operation).not.toHaveBeenCalled();
    });
  });

  describe('OPEN -> HALF_OPEN transition', () => {
    it('stays OPEN and fails fast before resetTimeoutMs elapses', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(breaker.execute(operation)).rejects.toThrow('boom');

      vi.advanceTimersByTime(9_999);
      operation.mockClear();
      await expect(breaker.execute(operation)).rejects.toThrow(CircuitOpenException);
      expect(operation).not.toHaveBeenCalled();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('transitions to HALF_OPEN and allows a trial call once resetTimeoutMs has elapsed', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      vi.advanceTimersByTime(10_000);
      operation.mockClear();
      operation.mockResolvedValue('ok');

      const result = await breaker.execute(operation);

      expect(operation).toHaveBeenCalledTimes(1);
      expect(result).toBe('ok');
    });

    it('emits a "half_open" event when the trial call begins', async () => {
      const breaker = new CircuitBreaker({
        name: 'horizon',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const onHalfOpen = vi.fn();
      breaker.on('half_open', onHalfOpen);

      const operation = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      vi.advanceTimersByTime(10_000);
      await breaker.execute(operation);

      expect(onHalfOpen).toHaveBeenCalledTimes(1);
      expect(onHalfOpen).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'horizon', state: CircuitState.HALF_OPEN }),
      );
    });
  });

  describe('HALF_OPEN -> CLOSED transition', () => {
    it('closes the circuit and resets the failure count after a successful trial call', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      vi.advanceTimersByTime(10_000);

      const result = await breaker.execute(operation);

      expect(result).toBe('ok');
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('emits a "close" event on recovery', async () => {
      const breaker = new CircuitBreaker({
        name: 'horizon',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const onClose = vi.fn();
      breaker.on('close', onClose);

      const operation = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      vi.advanceTimersByTime(10_000);
      await breaker.execute(operation);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'horizon', state: CircuitState.CLOSED, failureCount: 0 }),
      );
    });

    it('allows calls through normally again after closing', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok');
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      vi.advanceTimersByTime(10_000);
      await breaker.execute(operation); // trial succeeds, closes

      operation.mockClear();
      operation.mockResolvedValue('still-ok');
      const result = await breaker.execute(operation);

      expect(result).toBe('still-ok');
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('HALF_OPEN -> OPEN transition', () => {
    it('reopens the circuit when the trial call fails', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      vi.advanceTimersByTime(10_000);

      await expect(breaker.execute(operation)).rejects.toThrow('boom');

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('resets the timer so the circuit stays fail-fast for another full resetTimeoutMs', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      vi.advanceTimersByTime(10_000);
      await expect(breaker.execute(operation)).rejects.toThrow('boom'); // half-open trial fails -> re-opens

      vi.advanceTimersByTime(9_999);
      operation.mockClear();
      await expect(breaker.execute(operation)).rejects.toThrow(CircuitOpenException);
      expect(operation).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      operation.mockClear();
      operation.mockResolvedValue('recovered');
      const result = await breaker.execute(operation);
      expect(result).toBe('recovered');
    });

    it('emits "open" again when the half-open trial fails', async () => {
      const breaker = new CircuitBreaker({
        name: 'horizon',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
      });
      const onOpen = vi.fn();
      breaker.on('open', onOpen);

      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      vi.advanceTimersByTime(10_000);
      await expect(breaker.execute(operation)).rejects.toThrow('boom');

      expect(onOpen).toHaveBeenCalledTimes(2);
    });
  });

  describe('custom isFailure classifier', () => {
    it('does not count an error classified as "not a failure" toward the threshold', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 2,
        resetTimeoutMs: 10_000,
        isFailure: (error) => (error as Error).message !== 'ignore-me',
      });
      const operation = vi.fn().mockRejectedValue(new Error('ignore-me'));

      await expect(breaker.execute(operation)).rejects.toThrow('ignore-me');
      await expect(breaker.execute(operation)).rejects.toThrow('ignore-me');
      await expect(breaker.execute(operation)).rejects.toThrow('ignore-me');
      await expect(breaker.execute(operation)).rejects.toThrow('ignore-me');

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getFailureCount()).toBe(0);
      expect(operation).toHaveBeenCalledTimes(4);
    });

    it('still trips the breaker for errors the classifier does count', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 2,
        resetTimeoutMs: 10_000,
        isFailure: (error) => (error as Error).message !== 'ignore-me',
      });
      const operation = vi.fn().mockRejectedValue(new Error('real-failure'));

      await expect(breaker.execute(operation)).rejects.toThrow('real-failure');
      await expect(breaker.execute(operation)).rejects.toThrow('real-failure');

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('success/failure telemetry events', () => {
    it('emits "success" on a successful call', async () => {
      const breaker = new CircuitBreaker({
        name: 'horizon',
        failureThreshold: 3,
        resetTimeoutMs: 10_000,
      });
      const onSuccess = vi.fn();
      breaker.on('success', onSuccess);

      await breaker.execute(vi.fn().mockResolvedValue('ok'));

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'horizon', timestamp: expect.any(Number) }),
      );
    });

    it('emits "failure" with the error and running failure count on a failed call', async () => {
      const breaker = new CircuitBreaker({
        name: 'horizon',
        failureThreshold: 3,
        resetTimeoutMs: 10_000,
      });
      const onFailure = vi.fn();
      breaker.on('failure', onFailure);
      const error = new Error('boom');

      await expect(breaker.execute(vi.fn().mockRejectedValue(error))).rejects.toThrow('boom');

      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'horizon', error, failureCount: 1 }),
      );
    });
  });

  describe('halfOpenMaxAttempts', () => {
    it('fails fast once the half-open trial budget is exhausted', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-breaker',
        failureThreshold: 1,
        resetTimeoutMs: 10_000,
        halfOpenMaxAttempts: 1,
      });
      const operation = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      vi.advanceTimersByTime(10_000);

      // First half-open trial call is allowed through and fails, which
      // re-opens the circuit immediately.
      await expect(breaker.execute(operation)).rejects.toThrow('boom');
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });
});

describe('isRpcFailure', () => {
  it('treats DomainExceptions as not-a-failure (application errors, not RPC instability)', () => {
    const error = new DomainException(ErrorCode.INVALID_STELLAR_ADDRESS, 'bad address');
    expect(isRpcFailure(error)).toBe(false);
  });

  it('treats known network error codes as failures', () => {
    expect(isRpcFailure(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isRpcFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('treats HTTP 5xx statuses as failures', () => {
    expect(isRpcFailure({ status: 503 })).toBe(true);
    expect(isRpcFailure({ response: { status: 502 } })).toBe(true);
  });

  it('does not treat HTTP 4xx statuses as failures', () => {
    expect(isRpcFailure({ status: 400 })).toBe(false);
    expect(isRpcFailure({ response: { status: 404 } })).toBe(false);
  });

  it('defaults generic errors to failures', () => {
    expect(isRpcFailure(new Error('unexpected'))).toBe(true);
  });
});
