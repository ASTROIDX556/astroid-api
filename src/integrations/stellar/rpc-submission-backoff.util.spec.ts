import { describe, expect, it } from 'vitest';
import { computeRpcExponentialDelayMs } from './rpc-submission-backoff.util';

describe('computeRpcExponentialDelayMs (#300)', () => {
  it('scales retry delay exponentially up to maxDelayMs', () => {
    expect(computeRpcExponentialDelayMs(1, 250, 2000)).toBe(250);
    expect(computeRpcExponentialDelayMs(2, 250, 2000)).toBe(500);
    expect(computeRpcExponentialDelayMs(5, 250, 2000)).toBe(2000);
  });
});
