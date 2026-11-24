export function computeRpcExponentialDelayMs(
  attempt: number,
  initialDelayMs: number = 250,
  maxDelayMs: number = 8_000,
): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(maxDelayMs, initialDelayMs * Math.pow(2, exponent));
}
