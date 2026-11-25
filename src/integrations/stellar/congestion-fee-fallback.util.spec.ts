import { describe, expect, it } from 'vitest';
import { estimateCongestionResilientFee } from './congestion-fee-fallback.util';

describe('estimateCongestionResilientFee (#302)', () => {
  it('uses p90 network fee when available and caps at maxFeeCapStroops', () => {
    expect(
      estimateCongestionResilientFee({
        baseFeeStroops: 100,
        p90FeeStroops: 850,
        maxFeeCapStroops: 5000,
      }),
    ).toBe(850);

    expect(
      estimateCongestionResilientFee({
        baseFeeStroops: 100,
        p90FeeStroops: null,
        congestionMultiplier: 2,
      }),
    ).toBe(200);
  });
});
