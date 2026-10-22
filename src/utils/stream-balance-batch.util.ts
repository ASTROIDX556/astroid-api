export interface ActiveStreamDescriptor {
  streamId: string;
  ratePerSecondUnits: bigint;
  startTimestampSec: number;
  withdrawnUnits: bigint;
}

export interface BatchedStreamBalance {
  streamId: string;
  accruedUnits: bigint;
  withdrawableUnits: bigint;
}

export function calculateBatchedStreamBalances(
  streams: readonly ActiveStreamDescriptor[],
  nowTimestampSec: number,
): BatchedStreamBalance[] {
  return streams.map((s) => {
    const elapsed = BigInt(Math.max(0, Math.trunc(nowTimestampSec - s.startTimestampSec)));
    const accruedUnits = elapsed * s.ratePerSecondUnits;
    const withdrawableUnits =
      accruedUnits > s.withdrawnUnits ? accruedUnits - s.withdrawnUnits : 0n;
    return {
      streamId: s.streamId,
      accruedUnits,
      withdrawableUnits,
    };
  });
}
