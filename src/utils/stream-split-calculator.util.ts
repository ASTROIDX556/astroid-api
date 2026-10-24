export const TOTAL_BASIS_POINTS = 10_000n;

export interface StreamSplitRecipientShare {
  recipient: string;
  basisPoints: number;
}

export interface StreamSplitAllocation {
  recipient: string;
  basisPoints: number;
  amountUnits: bigint;
}

export function calculateStreamSplitAllocations(
  totalAmountUnits: bigint,
  shares: StreamSplitRecipientShare[],
): StreamSplitAllocation[] {
  if (totalAmountUnits < 0n) {
    throw new Error('Total stream amount cannot be negative');
  }
  if (shares.length === 0) {
    throw new Error('At least one split recipient is required');
  }

  let bpsSum = 0;
  for (const s of shares) {
    if (!Number.isInteger(s.basisPoints) || s.basisPoints <= 0) {
      throw new Error('Recipient basisPoints must be a positive integer');
    }
    bpsSum += s.basisPoints;
  }

  if (BigInt(bpsSum) !== TOTAL_BASIS_POINTS) {
    throw new Error(
      `Recipient basisPoints must sum to ${TOTAL_BASIS_POINTS.toString()} (got ${bpsSum})`,
    );
  }

  const provisional = shares.map((s, index) => {
    const numerator = totalAmountUnits * BigInt(s.basisPoints);
    const floorAmount = numerator / TOTAL_BASIS_POINTS;
    const remainder = numerator % TOTAL_BASIS_POINTS;
    return {
      index,
      recipient: s.recipient,
      basisPoints: s.basisPoints,
      amountUnits: floorAmount,
      remainder,
    };
  });

  const allocatedSum = provisional.reduce((acc, p) => acc + p.amountUnits, 0n);
  let dust = totalAmountUnits - allocatedSum;

  const byRemainder = [...provisional].sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder > a.remainder ? 1 : -1;
    }
    return a.index - b.index;
  });

  for (let i = 0; i < byRemainder.length && dust > 0n; i++) {
    byRemainder[i].amountUnits += 1n;
    dust -= 1n;
  }

  return provisional.map(({ recipient, basisPoints, amountUnits }) => ({
    recipient,
    basisPoints,
    amountUnits,
  }));
}
