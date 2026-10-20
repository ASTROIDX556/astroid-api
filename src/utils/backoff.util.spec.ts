import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  exponentialBackoffDelay,
  exponentialBackoffWithJitter,
  jitteredBackoffDelay,
  jitteredBackoffStrategy,
} from './backoff.util';

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

  describe('jitteredBackoffStrategy', () => {
    it('returns a delay consistent with the backoff algorithm', () => {
      vi.mocked(Math.random).mockReturnValue(0);

      const strategy = jitteredBackoffStrategy(2_000);

      // The strategy receives the 1-based attempt number BullMQ passes to it,
      // so the first retry waits the base delay.
      expect(strategy(1, 'custom', new Error('test')) as number).toBe(2000);
      expect(strategy(2, 'custom', new Error('test')) as number).toBe(4000);
      expect(strategy(3, 'custom', new Error('test')) as number).toBe(8000);
    });

    it('adds jitter to prevent thundering herd', () => {
      const strategy = jitteredBackoffStrategy(2_000);
      const delays: number[] = [];
      for (let i = 0; i < 10; i++) {
        vi.mocked(Math.random).mockReturnValue(i / 10);
        delays.push(strategy(2, 'custom', new Error('test')) as number);
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

    it('caps the delay at the configured maximum', () => {
      const strategy = jitteredBackoffStrategy(2_000, 5_000);

      vi.mocked(Math.random).mockReturnValue(1);

      expect(strategy(10, 'custom', new Error('test')) as number).toBe(5_000);
    });

    it('is compatible with BullMQ BackoffStrategy type', () => {
      const strategy = jitteredBackoffStrategy(2_000);
      expect(typeof strategy).toBe('function');
    });

    it('works when err and job are not provided', () => {
      vi.mocked(Math.random).mockReturnValue(0);
      const delay = jitteredBackoffStrategy(2_000)(1) as number;
      expect(delay).toBe(2000);
    });
  });
});

describe('exponentialBackoffDelay', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('doubles the base delay per attempt', () => {
    expect(exponentialBackoffDelay(1, 2_000)).toBe(2_000);
    expect(exponentialBackoffDelay(2, 2_000)).toBe(4_000);
    expect(exponentialBackoffDelay(3, 2_000)).toBe(8_000);
    expect(exponentialBackoffDelay(4, 2_000)).toBe(16_000);
  });

  it('caps the delay at the configured maximum', () => {
    expect(exponentialBackoffDelay(4, 2_000, 10_000)).toBe(10_000);
    expect(exponentialBackoffDelay(10, 2_000, 10_000)).toBe(10_000);
  });

  it('leaves a delay below the maximum untouched', () => {
    expect(exponentialBackoffDelay(1, 2_000, 10_000)).toBe(2_000);
    expect(exponentialBackoffDelay(2, 2_000, 10_000)).toBe(4_000);
  });
});

describe('exponentialBackoffWithJitter — maximum delay', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never exceeds the configured maximum delay', () => {
    vi.mocked(Math.random).mockReturnValue(1);

    expect(exponentialBackoffWithJitter(10, 2_000, 0.2, 30_000)).toBe(30_000);
    expect(exponentialBackoffWithJitter(4, 2_000, 0.2, 5_000)).toBe(5_000);
  });

  it('is unbounded when no maximum is configured', () => {
    vi.mocked(Math.random).mockReturnValue(0);

    expect(exponentialBackoffWithJitter(10, 2_000, 0.2)).toBe(2_000 * 2 ** 9);
  });
});

describe('jitteredBackoffDelay', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is the delay of the attempt that follows the given number of failures', () => {
    vi.mocked(Math.random).mockReturnValue(0);

    // The attempt number is 1-based — the same argument BullMQ hands to a
    // custom backoff strategy — so the first retry waits the base delay.
    expect(jitteredBackoffDelay(1, 2_000)).toBe(2_000);
    expect(jitteredBackoffDelay(2, 2_000)).toBe(4_000);
    expect(jitteredBackoffDelay(3, 2_000)).toBe(8_000);
  });

  it('applies the maximum delay to the total', () => {
    vi.mocked(Math.random).mockReturnValue(1);

    expect(jitteredBackoffDelay(5, 2_000, 10_000)).toBe(10_000);
  });
});
