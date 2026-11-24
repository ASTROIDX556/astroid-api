import { registerAs } from '@nestjs/config';
import { priceOracleEnvSchema, validateEnv } from './env.validation';

export type PriceOracleConfig = {
  /** Whether the HTTP price source may be queried. */
  enabled: boolean;
  /** Provider-neutral JSON endpoint returning `{ quotes: { ASSET: { price, asOf } } }`. */
  url: string;
  /** Optional bearer token for the price endpoint. */
  apiKey: string;
  /** HTTP timeout for a single quote request (ms). */
  timeoutMs: number;
  /** Quotes older than this are rejected as stale (ms). */
  maxAgeMs: number;
  /** Operator-managed static quote table, keyed by upper-case asset code. */
  staticPrices: Record<string, number>;
};

/**
 * Parses the `ASSET=PRICE,ASSET2=PRICE2` static quote table. Malformed
 * entries are rejected at boot so a typo can never silently disable a limit.
 */
export function parseStaticPrices(raw: string): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      throw new Error(
        `Invalid PRICE_ORACLE_STATIC_PRICES entry '${trimmed}': expected ASSET=PRICE`,
      );
    }
    const asset = trimmed.slice(0, separator).trim().toUpperCase();
    const value = Number(trimmed.slice(separator + 1).trim());
    if (!asset || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Invalid PRICE_ORACLE_STATIC_PRICES entry '${trimmed}': price must be a positive number`,
      );
    }
    prices[asset] = value;
  }
  return prices;
}

export const priceOracleConfig = registerAs('priceOracle', (): PriceOracleConfig => {
  const env = validateEnv(priceOracleEnvSchema, process.env);
  return {
    enabled: env.PRICE_ORACLE_ENABLED,
    url: env.PRICE_ORACLE_URL,
    apiKey: env.PRICE_ORACLE_API_KEY,
    timeoutMs: env.PRICE_ORACLE_TIMEOUT_MS,
    maxAgeMs: env.PRICE_ORACLE_MAX_AGE_MS,
    staticPrices: parseStaticPrices(env.PRICE_ORACLE_STATIC_PRICES),
  };
});
