import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { HorizonCircuitBreakerService } from './horizon-circuit-breaker.service';
import { CircuitState } from '../../common/circuit-breaker/circuit-breaker';
import { CircuitOpenException, DomainException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';

function buildMockConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const get = vi.fn((key: string) => overrides[key]);
  return { get } as unknown as ConfigService;
}

/** Awaits the rejection of a promise and swallows the error. */
async function swallowRejection(promise: Promise<unknown>): Promise<void> {
  try { await promise; } catch { /* expected */ }
}

describe('HorizonCircuitBreakerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction and configuration', () => {
    it('creates a breaker with default config when no env vars are set', () => {
      const config = buildMockConfig();
      const service = new HorizonCircuitBreakerService(config);

      expect(service.getState()).toBe(CircuitState.CLOSED);
      expect(service.getFailureCount()).toBe(0);
      expect(service.getName()).toBe('horizon');
    });

    it('reads failure threshold from config', async () => {
      const config = buildMockConfig({
        STELLAR_CIRCUIT_BREAKER_FAILURE_THRESHOLD: 3,
      });
      const service = new HorizonCircuitBreakerService(config);

      const op = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }));
      for (let i = 0; i < 3; i++) {
        await swallowRejection(service.executeWithFallback('test', op));
      }

      expect(service.getState()).toBe(CircuitState.OPEN);
    });

    it('reads reset timeout from config', async () => {
      const config = buildMockConfig({
        STELLAR_CIRCUIT_BREAKER_FAILURE_THRESHOLD: 1,
        STELLAR_CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 5_000,
      });
      const service = new HorizonCircuitBreakerService(config);
      const op = vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));

      // Trip open
      await swallowRejection(service.executeWithFallback('test', op));
      expect(service.getState()).toBe(CircuitState.OPEN);

      // Before timeout: still OPEN
      vi.advanceTimersByTime(4_999);
      op.mockClear();
      op.mockResolvedValue('ok');
      await swallowRejection(service.executeWithFallback('test', op));
      expect(op).not.toHaveBeenCalled();

      // After timeout: transitions to HALF_OPEN and allows trial
      vi.advanceTimersByTime(1);
      const result = await service.executeWithFallback('test', op);
      expect(result).toBe('ok');
    });
  });

  describe('CLOSED state', () => {
    it('allows calls through normally', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      const operation = vi.fn().mockResolvedValue({ balance: '100' });

      const result = await service.executeWithFallback('getBalances', operation);

      expect(result).toEqual({ balance: '100' });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(service.getState()).toBe(CircuitState.CLOSED);
    });

    it('resets failure count after a success', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      const operation = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
        .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
        .mockResolvedValueOnce('ok');

      await swallowRejection(service.executeWithFallback('test', operation));
      await swallowRejection(service.executeWithFallback('test', operation));
      await service.executeWithFallback('test', operation);

      expect(service.getFailureCount()).toBe(0);
    });

    it('propagates the original error (not CircuitOpenException)', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      const operation = vi.fn().mockRejectedValue(new Error('upstream exploded'));

      await expect(service.executeWithFallback('test', operation)).rejects.toThrow(
        'upstream exploded',
      );
    });
  });

  describe('CLOSED -> OPEN transition (trip condition)', () => {
    it('trips OPEN after default 5 consecutive failures', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      const operation = vi.fn().mockRejectedValue(
        Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      );

      for (let i = 0; i < 5; i++) {
        await swallowRejection(service.executeWithFallback('test', operation));
      }

      expect(service.getState()).toBe(CircuitState.OPEN);
      expect(service.getFailureCount()).toBe(5);
    });

    it('only counts RPC-classified failures (not DomainExceptions)', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      const operation = vi
        .fn()
        .mockRejectedValueOnce(
          new DomainException(ErrorCode.INVALID_STELLAR_ADDRESS, 'bad'),
        )
        .mockRejectedValueOnce(
          new DomainException(ErrorCode.INVALID_STELLAR_ADDRESS, 'bad'),
        )
        .mockRejectedValueOnce(
          new DomainException(ErrorCode.INVALID_STELLAR_ADDRESS, 'bad'),
        );

      for (let i = 0; i < 3; i++) {
        await swallowRejection(service.executeWithFallback('test', operation));
      }

      expect(service.getState()).toBe(CircuitState.CLOSED);
      expect(service.getFailureCount()).toBe(0);
    });

    it('does not trip for HTTP 4xx errors (client errors)', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      const operation = vi.fn().mockRejectedValue({ status: 400 });

      for (let i = 0; i < 10; i++) {
        await swallowRejection(service.executeWithFallback('test', operation));
      }

      expect(service.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('OPEN state (fail fast with fallback)', () => {
    async function tripOpen(service: HorizonCircuitBreakerService): Promise<void> {
      const op = vi.fn().mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }),
      );
      for (let i = 0; i < 5; i++) {
        await swallowRejection(service.executeWithFallback('test', op));
      }
      expect(service.getState()).toBe(CircuitState.OPEN);
    }

    it('invokes fallback strategy when circuit is open', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      await tripOpen(service);

      const operation = vi.fn();
      const fallback = vi.fn().mockResolvedValue({ balance: 'stale-data' });
      const result = await service.executeWithFallback('test', operation, {
        name: 'cached-balance',
        execute: fallback,
      });

      expect(result).toEqual({ balance: 'stale-data' });
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(operation).not.toHaveBeenCalled();
    });

    it('invokes registered fallback strategy by operation name', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      service.registerFallback('getNativeBalance', {
        name: 'cached-native',
        execute: () => '0.0000000',
      });
      await tripOpen(service);

      const operation = vi.fn();
      const result = await service.executeWithFallback('getNativeBalance', operation);

      expect(result).toBe('0.0000000');
      expect(operation).not.toHaveBeenCalled();
    });

    it('throws CircuitOpenException when no fallback is registered', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      await tripOpen(service);

      const operation = vi.fn();
      await expect(service.executeWithFallback('test', operation)).rejects.toThrow(
        CircuitOpenException,
      );
    });

    it('wraps failing fallback in STELLAR_ERROR exception', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      await tripOpen(service);

      const operation = vi.fn();
      const brokenFallback = vi.fn().mockRejectedValue(new Error('cache miss'));
      await expect(
        service.executeWithFallback('test', operation, {
          name: 'broken',
          execute: brokenFallback,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.STELLAR_ERROR });
    });
  });

  describe('OPEN -> HALF_OPEN -> CLOSED (recovery probe)', () => {
    async function tripOpen(service: HorizonCircuitBreakerService): Promise<void> {
      const op = vi.fn().mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }),
      );
      for (let i = 0; i < 5; i++) {
        await swallowRejection(service.executeWithFallback('test', op));
      }
      expect(service.getState()).toBe(CircuitState.OPEN);
    }

    it('allows trial calls after resetTimeoutMs elapses', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      await tripOpen(service);

      // Advance past resetTimeout (30s default)
      vi.advanceTimersByTime(30_000);

      const operation = vi.fn().mockResolvedValue('recovered');
      const result = await service.executeWithFallback('test', operation);

      expect(result).toBe('recovered');
      expect(service.getState()).toBe(CircuitState.CLOSED);
      expect(service.getFailureCount()).toBe(0);
    });

    it('re-opens circuit when the half-open trial call fails', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      await tripOpen(service);

      // Half-open trial fails
      vi.advanceTimersByTime(30_000);
      const operation = vi.fn().mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }),
      );
      await swallowRejection(service.executeWithFallback('test', operation));

      expect(service.getState()).toBe(CircuitState.OPEN);
    });

    it('resets timer after half-open failure, stays fail-fast for full interval', async () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      await tripOpen(service);

      // Half-open trial fails
      vi.advanceTimersByTime(30_000);
      const operation = vi.fn().mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }),
      );
      await swallowRejection(service.executeWithFallback('test', operation));

      // 29.9s later: still OPEN
      vi.advanceTimersByTime(29_999);
      const failOp = vi.fn().mockRejectedValue(new Error('nope'));
      await expect(service.executeWithFallback('test', failOp)).rejects.toThrow(
        CircuitOpenException,
      );
      expect(failOp).not.toHaveBeenCalled();

      // 30s later: HALF_OPEN, trial allowed
      vi.advanceTimersByTime(1);
      operation.mockResolvedValue('finally-ok');
      const result = await service.executeWithFallback('test', operation);
      expect(result).toBe('finally-ok');
    });
  });

  describe('fallback strategy registration', () => {
    it('registers and unregisters fallback strategies', () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      const strategy = { name: 'cached', execute: () => 'data' };

      service.registerFallback('getBalances', strategy);
      expect(service.getSnapshot().registeredFallbacks).toContain('getBalances');

      service.unregisterFallback('getBalances');
      expect(service.getSnapshot().registeredFallbacks).not.toContain('getBalances');
    });

    it('registered fallbacks appear in snapshot', () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      service.registerFallback('op1', { name: 'f1', execute: () => {} });
      service.registerFallback('op2', { name: 'f2', execute: () => {} });

      const snapshot = service.getSnapshot();
      expect(snapshot.registeredFallbacks).toHaveLength(2);
      expect(snapshot.registeredFallbacks).toContain('op1');
      expect(snapshot.registeredFallbacks).toContain('op2');
    });
  });

  describe('snapshot', () => {
    it('returns current state, failure count, and registered fallbacks', () => {
      const service = new HorizonCircuitBreakerService(buildMockConfig());
      const snapshot = service.getSnapshot();

      expect(snapshot).toEqual({
        name: 'horizon',
        state: CircuitState.CLOSED,
        failureCount: 0,
        registeredFallbacks: [],
      });
    });
  });
});
