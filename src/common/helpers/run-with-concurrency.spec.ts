import { describe, expect, it } from 'vitest';
import { runWithConcurrency } from './run-with-concurrency';

const tick = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runWithConcurrency', () => {
  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
    });

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never keeps more than the configured number of workers in flight', async () => {
    let active = 0;
    let maxActive = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      active -= 1;
    });

    expect(maxActive).toBe(2);
  });

  it('handles an empty list and a non-positive limit', async () => {
    const worker = async () => undefined;
    await expect(runWithConcurrency([], 3, worker)).resolves.toBeUndefined();
    await expect(runWithConcurrency([1, 2], 0, worker)).resolves.toBeUndefined();
  });

  it('propagates a worker rejection to the caller', async () => {
    await expect(
      runWithConcurrency([1], 1, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
