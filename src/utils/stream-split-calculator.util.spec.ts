import { describe, expect, it } from 'vitest';
import { calculateStreamSplitAllocations } from './stream-split-calculator.util';

describe('calculateStreamSplitAllocations (#305)', () => {
  it('allocates odd token amounts across 3 equal recipients without losing remainder dust', () => {
    const allocations = calculateStreamSplitAllocations(100n, [
      { recipient: 'G_ALICE', basisPoints: 3334 },
      { recipient: 'G_BOB', basisPoints: 3333 },
      { recipient: 'G_CAROL', basisPoints: 3333 },
    ]);

    const sum = allocations.reduce((acc, a) => acc + a.amountUnits, 0n);
    expect(sum).toBe(100n);
    expect(allocations.map((a) => a.amountUnits)).toEqual([34n, 33n, 33n]);
  });

  it('handles single-recipient 100% streams and zero-amount streams cleanly', () => {
    const single = calculateStreamSplitAllocations(5_000_000n, [
      { recipient: 'G_SOLO', basisPoints: 10_000 },
    ]);
    expect(single).toEqual([
      { recipient: 'G_SOLO', basisPoints: 10_000, amountUnits: 5_000_000n },
    ]);

    const zero = calculateStreamSplitAllocations(0n, [
      { recipient: 'G_A', basisPoints: 5000 },
      { recipient: 'G_B', basisPoints: 5000 },
    ]);
    expect(zero.map((z) => z.amountUnits)).toEqual([0n, 0n]);
  });

  it('rejects non-10000 bps sums, zero percentages, or negative amounts', () => {
    expect(() =>
      calculateStreamSplitAllocations(100n, [
        { recipient: 'G_A', basisPoints: 5000 },
      ]),
    ).toThrow(/must sum to 10000/);

    expect(() =>
      calculateStreamSplitAllocations(100n, [
        { recipient: 'G_A', basisPoints: 0 },
        { recipient: 'G_B', basisPoints: 10_000 },
      ]),
    ).toThrow(/positive integer/);
  });
});
