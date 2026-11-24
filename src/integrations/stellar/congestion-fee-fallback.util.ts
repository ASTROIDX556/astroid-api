export interface FeeEstimationInput {
  baseFeeStroops: number;
  p90FeeStroops?: number | null;
  congestionMultiplier?: number;
  maxFeeCapStroops?: number;
}

export function estimateCongestionResilientFee(input: FeeEstimationInput): number {
  const base = Math.max(100, Math.trunc(input.baseFeeStroops));
  const multiplier = Math.max(1, input.congestionMultiplier ?? 1.5);
  const maxCap = Math.max(base, input.maxFeeCapStroops ?? 100_000);

  const reference =
    typeof input.p90FeeStroops === 'number' &&
    Number.isFinite(input.p90FeeStroops) &&
    input.p90FeeStroops > base
      ? input.p90FeeStroops
      : base * multiplier;

  return Math.min(maxCap, Math.ceil(reference));
}
