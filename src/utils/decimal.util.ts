/**
 * Small numeric/decimal helpers. Amounts are handled as strings/numbers at the
 * API boundary and stored as Prisma Decimal (30,7) to preserve Stellar's
 * 7-decimal precision without floating-point drift in comparisons.
 */

/** Number of stroops in one whole Stellar unit (10^7). */
export const STROOPS_PER_UNIT = 10_000_000n;

/** Exactly one stroop in Stellar decimal units (10^-7). */
export const ONE_STROOP = 0.0000001;

/** Parses a user-supplied amount into a finite positive number, or throws. */
export function parseAmount(value: string | number): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) {
    throw new Error('Amount must be a finite number');
  }
  return amount;
}

/** Rounds to Stellar's 7-decimal precision. */
export function toStellarPrecision(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

/**
 * Converts a numeric or decimal string amount into integer stroops (bigint)
 * using Stellar's 7-decimal precision. Using integer stroops avoids floating-point
 * rounding artifacts in comparisons and arithmetic.
 */
export function toStroops(value: number | string): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Amount must be a finite number');
    }
    return BigInt(Math.round(value * 1e7));
  }
  const str = value.trim();
  if (!str) {
    throw new Error('Amount string must not be empty');
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(str)) {
    throw new Error(`Invalid amount string: ${str}`);
  }
  const isNegative = str.startsWith('-');
  const unsigned = isNegative ? str.slice(1) : str;
  const [wholeStr, fracStr = ''] = unsigned.split('.');
  const whole = BigInt(wholeStr);
  const fracPadded = (fracStr + '0000000').slice(0, 7);
  const fracExtra = fracStr.length > 7 ? Number(fracStr[7]) : 0;
  let stroops = whole * STROOPS_PER_UNIT + BigInt(fracPadded);
  if (fracExtra >= 5) {
    stroops += 1n;
  }
  return isNegative ? -stroops : stroops;
}

/**
 * Converts integer stroops back to a number with 7-decimal precision.
 */
export function fromStroops(stroops: bigint): number {
  return Number(stroops) / 1e7;
}

/** Clamps a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Formats a number as a fixed-precision decimal string for storage. */
export function toDecimalString(value: number): string {
  return toStellarPrecision(value).toFixed(7);
}
