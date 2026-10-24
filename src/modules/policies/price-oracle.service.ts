import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';
import { PriceOracleConfig } from '../../config/price-oracle.config';
import { assetCodeOf } from '../../utils/asset.util';

/** A price quote for one asset, denominated in a base currency. */
export interface PriceQuote {
  /** Upper-case asset code the quote is for. */
  asset: string;
  /** Upper-case base currency the price is expressed in. */
  base: string;
  /** Price of one unit of the asset, expressed in `base`. */
  price: number;
  /** When the quote was produced. */
  asOf: Date;
  /** Where the quote came from. */
  source: 'static' | 'http';
}

/** Why a quote could not be produced. */
export type PriceUnavailableReason = 'unavailable' | 'stale' | 'invalid' | 'disabled';

/**
 * Raised when a price quote required to evaluate a limit is not available.
 *
 * The failure is deliberately fatal for the transaction: a limit denominated
 * in a base currency can only be enforced when the price is known, so the
 * platform blocks the transfer instead of treating the unknown price as zero
 * (which would let any amount through).
 */
export class PriceUnavailableException extends DomainException {
  constructor(
    readonly reason: PriceUnavailableReason,
    asset: string,
    base: string,
    message: string,
  ) {
    super(ErrorCode.PRICE_UNAVAILABLE, message, { reason, asset, base });
  }
}

interface CachedQuote {
  quote: PriceQuote;
  expiresAt: number;
}

/**
 * Converts asset amounts into a base currency.
 *
 * Two sources are supported and always consulted in this order:
 *
 *  1. **Static prices** — an operator-managed table (`PRICE_ORACLE_STATIC_PRICES`).
 *     Deterministic, offline-friendly and considered fresh at all times.
 *  2. **HTTP oracle** — a provider-neutral JSON endpoint that receives
 *     `?base=<BASE>&assets=<ASSET>` and answers with
 *     `{ "quotes": { "<ASSET>": { "price": 0.11, "asOf": "2026-01-01T00:00:00Z" } } }`.
 *
 * Quotes older than `PRICE_ORACLE_MAX_AGE_MS` are rejected as stale. Every
 * failure path raises {@link PriceUnavailableException}; a missing price is
 * never silently converted to zero.
 */
@Injectable()
export class PriceOracleService {
  private readonly cache = new Map<string, CachedQuote>();

  constructor(private readonly config: ConfigService) {}

  /** The resolved price-oracle configuration. */
  private get settings(): PriceOracleConfig {
    return (
      this.config.get<PriceOracleConfig>('priceOracle') ?? {
        enabled: false,
        url: '',
        apiKey: '',
        timeoutMs: 3_000,
        maxAgeMs: 300_000,
        staticPrices: {},
      }
    );
  }

  /**
   * Returns a quote for `asset` denominated in `base`.
   *
   * @throws PriceUnavailableException when no usable quote exists.
   */
  async getQuote(asset: string, base: string): Promise<PriceQuote> {
    const assetCode = assetCodeOf(asset);
    const baseCode = base.toUpperCase();

    if (assetCode === baseCode) {
      return {
        asset: assetCode,
        base: baseCode,
        price: 1,
        asOf: new Date(),
        source: 'static',
      };
    }

    const cached = this.cache.get(`${assetCode}:${baseCode}`);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.quote;
    }

    const quote = await this.fetchQuote(assetCode, baseCode);
    const ttl = Math.max(1_000, Math.floor(this.settings.maxAgeMs / 2));
    this.cache.set(`${assetCode}:${baseCode}`, { quote, expiresAt: Date.now() + ttl });
    return quote;
  }

  /**
   * Converts an amount denominated in `asset` into `base`.
   *
   * @throws PriceUnavailableException when the conversion cannot be performed.
   */
  async convert(amount: number, asset: string, base: string): Promise<number> {
    const quote = await this.getQuote(asset, base);
    const converted = amount * quote.price;
    if (!Number.isFinite(converted)) {
      throw new PriceUnavailableException(
        'invalid',
        assetCodeOf(asset),
        base.toUpperCase(),
        `Price conversion for asset ${assetCodeOf(asset)} produced a non-finite amount`,
      );
    }
    return converted;
  }

  /** Clears the in-memory quote cache (used by tests and by manual refreshes). */
  clearCache(): void {
    this.cache.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async fetchQuote(assetCode: string, baseCode: string): Promise<PriceQuote> {
    const settings = this.settings;

    const staticPrice = settings.staticPrices[assetCode];
    if (staticPrice !== undefined) {
      return {
        asset: assetCode,
        base: baseCode,
        price: staticPrice,
        asOf: new Date(),
        source: 'static',
      };
    }

    if (!settings.enabled || !settings.url) {
      throw new PriceUnavailableException(
        'disabled',
        assetCode,
        baseCode,
        `No price source is configured for asset ${assetCode}; enable the price oracle or configure a static price before evaluating base-currency limits`,
      );
    }

    let payload: unknown;
    try {
      payload = await this.requestQuote(settings, assetCode, baseCode);
    } catch (error) {
      throw new PriceUnavailableException(
        'unavailable',
        assetCode,
        baseCode,
        `Price quote for asset ${assetCode} in ${baseCode} is unavailable: ${(error as Error).message}`,
      );
    }

    const quote = this.parseQuote(payload, assetCode, baseCode);
    const ageMs = Date.now() - quote.asOf.getTime();
    if (ageMs > settings.maxAgeMs) {
      throw new PriceUnavailableException(
        'stale',
        assetCode,
        baseCode,
        `Price quote for asset ${assetCode} in ${baseCode} is stale (age ${Math.round(ageMs / 1000)}s exceeds the ${Math.round(settings.maxAgeMs / 1000)}s limit)`,
      );
    }
    return quote;
  }

  private async requestQuote(
    settings: PriceOracleConfig,
    assetCode: string,
    baseCode: string,
  ): Promise<unknown> {
    const url = new URL(settings.url);
    url.searchParams.set('base', baseCode);
    url.searchParams.set('assets', assetCode);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {},
      });
      if (!response.ok) {
        throw new Error(`price endpoint responded with HTTP ${response.status}`);
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseQuote(payload: unknown, assetCode: string, baseCode: string): PriceQuote {
    const quotes = (payload as { quotes?: Record<string, unknown> } | null)?.quotes;
    const entry = quotes?.[assetCode] ?? quotes?.[assetCode.toLowerCase()];
    if (!entry || typeof entry !== 'object') {
      throw new PriceUnavailableException(
        'invalid',
        assetCode,
        baseCode,
        `Price quote for asset ${assetCode} in ${baseCode} is missing from the oracle response`,
      );
    }

    const { price, asOf } = entry as { price?: unknown; asOf?: unknown };
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new PriceUnavailableException(
        'invalid',
        assetCode,
        baseCode,
        `Price quote for asset ${assetCode} in ${baseCode} is invalid`,
      );
    }

    const timestamp = typeof asOf === 'string' ? Date.parse(asOf) : Number.NaN;
    if (!Number.isFinite(timestamp)) {
      throw new PriceUnavailableException(
        'invalid',
        assetCode,
        baseCode,
        `Price quote for asset ${assetCode} in ${baseCode} has an invalid timestamp`,
      );
    }

    return { asset: assetCode, base: baseCode, price, asOf: new Date(timestamp), source: 'http' };
  }
}
