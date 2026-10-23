import { describe, expect, it } from 'vitest';
import { calculateBatchedStreamBalances } from './stream-balance-batch.util';

describe('calculateBatchedStreamBalances (#276)', () => {
  it('computes accrued and withdrawable balances across multiple streams in a single batch', () => {
    const res = calculateBatchedStreamBalances(
      [
        {
          streamId: 'stream-1',
          ratePerSecondUnits: 100n,
          startTimestampSec: 1_000,
          withdrawnUnits: 2_000n,
        },
        {
          streamId: 'stream-2',
          ratePerSecondUnits: 50n,
          startTimestampSec: 1_050,
          withdrawnUnits: 0n,
        },
      ],
      1_100,
    );

    expect(res).toEqual([
      { streamId: 'stream-1', accruedUnits: 10_000n, withdrawableUnits: 8_000n },
      { streamId: 'stream-2', accruedUnits: 2_500n, withdrawableUnits: 2_500n },
    ]);
  });
});
