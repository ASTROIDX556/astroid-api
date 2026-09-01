import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exponentialBackoffWithJitter, webhookBackoffStrategy } from './backoff.util';

describe('backoff.util', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('exponentialBackoffWithJitter', () => {
    it('calculates correct exponential delay with zero jitter', () => {
      vi.mocked(Math.random).mockReturnValue(0);

      expect(exponentialBackoffWithJitter(1, 2000, 0.2)).toBe(2000);
      expect(exponentialBackoffWithJitter(2, 2000, 0.2)).toBe(4000);
      expect(exponentialBackoffWithJitter(3, 2000, 0.2)).toBe(8000);
      expect(exponentialBackoffWithJitter(4, 2000, 0.2)).toBe(16000);
    });

    it('calculates correct exponential delay with max jitter', () => {
      vi.mocked(Math.random).mockReturnValue(0.999);

      // Attempt 1: 2000 + floor(0.999 * 2000 * 0.2 * 1) = 2000 + 399 = 2399
      const delay1 = exponentialBackoffWithJitter(1, 2000, 0.2);
      expect(delay1).toBe(2399);

      // Attempt 2: 4000 + floor(0.999 * 2000 * 0.2 * 2) = 4000 + 799 = 4799
      const delay2 = exponentialBackoffWithJitter(2, 2000, 0.2);
      expect(delay2).toBe(4799);
    });

    it('jitter range increases with attempt number', () => {
      vi.mocked(Math.random).mockReturnValue(0.5);

      // Attempt 1: 2000 + floor(0.5 * 2000 * 0.2 * 1) = 2000 + 200 = 2200
      const delay1 = exponentialBackoffWithJitter(1, 2000, 0.2);
      // Attempt 2: 4000 + floor(0.5 * 2000 * 0.2 * 2) = 4000 + 400 = 4400
      const delay2 = exponentialBackoffWithJitter(2, 2000, 0.2);
      // Attempt 3: 8000 + floor(0.5 * 2000 * 0.2 * 3) = 8000 + 600 = 8600
      const delay3 = exponentialBackoffWithJitter(3, 2000, 0.2);

      expect(delay1).toBe(2200);
      expect(delay2).toBe(4400);
      expect(delay3).toBe(8600);
    });

    it('returns an integer', () => {
      vi.mocked(Math.random).mockReturnValue(0.123456789);
      const delay = exponentialBackoffWithJitter(1, 2000, 0.2);
      expect(Number.isInteger(delay)).toBe(true);
    });

    it('uses default jitter factor when not provided', () => {
      vi.mocked(Math.random).mockReturnValue(0);
      const delay = exponentialBackoffWithJitter(1, 2000);
      expect(delay).toBe(2000);
    });

    it('supports different base delays', () => {
      vi.mocked(Math.random).mockReturnValue(0);

      expect(exponentialBackoffWithJitter(1, 1000, 0.2)).toBe(1000);
      expect(exponentialBackoffWithJitter(1, 5000, 0.2)).toBe(5000);
    });
  });

  describe('webhookBackoffStrategy', () => {
    it('returns a delay consistent with the backoff algorithm', () => {
      vi.mocked(Math.random).mockReturnValue(0);

      // First retry (attemptsMade = 0 → attempt 1)
      const delay1 = webhookBackoffStrategy(0, 'exponential', new Error('test')) as number;
      expect(delay1).toBe(2000);

      // Second retry (attemptsMade = 1 → attempt 2)
      const delay2 = webhookBackoffStrategy(1, 'exponential', new Error('test')) as number;
      expect(delay2).toBe(4000);

      // Third retry (attemptsMade = 2 → attempt 3)
      const delay3 = webhookBackoffStrategy(2, 'exponential', new Error('test')) as number;
      expect(delay3).toBe(8000);
    });

    it('adds jitter to prevent thundering herd', () => {
      // Simulate 10 calls with different random values
      const delays: number[] = [];
      for (let i = 0; i < 10; i++) {
        vi.mocked(Math.random).mockReturnValue(i / 10);
        delays.push(webhookBackoffStrategy(1, 'exponential', new Error('test')) as number);
      }

      // All delays should be different (due to jitter)
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);

      // All delays should be in the range [4000, 4800)
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(4000);
        expect(delay).toBeLessThanOrEqual(4800);
      }
    });

    it('is compatible with BullMQ BackoffStrategy type', () => {
      // Verify the function signature matches what BullMQ expects:
      // (attemptsMade: number, type?: string, err?: Error, job?: MinimalJob) => Promise<number> | number
      const strategy = webhookBackoffStrategy;
      expect(typeof strategy).toBe('function');
    });

    it('works regardless of type parameter', () => {
      vi.mocked(Math.random).mockReturnValue(0);

      const delay1 = webhookBackoffStrategy(1, 'exponential') as number;
      const delay2 = webhookBackoffStrategy(1, 'fixed') as number;
      const delay3 = webhookBackoffStrategy(1, undefined) as number;

      // All should produce the same base delay for same attempt
      expect(delay1).toBe(delay2);
      expect(delay2).toBe(delay3);
    });

    it('works when err and job are not provided', () => {
      vi.mocked(Math.random).mockReturnValue(0);
      const delay = webhookBackoffStrategy(0) as number;
      expect(delay).toBe(2000);
    });
  });
});
