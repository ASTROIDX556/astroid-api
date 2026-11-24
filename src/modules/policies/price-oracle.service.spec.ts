import { describe, expect, it, vi, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PriceOracleService, PriceUnavailableException } from './price-oracle.service';
import { PriceOracleConfig } from '../../config/price-oracle.config';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function oracle(overrides: Partial<PriceOracleConfig> = {}): PriceOracleService {
  const settings: PriceOracleConfig = {
    enabled: false,
    url: '',
    apiKey: '',
    timeoutMs: 3_000,
    maxAgeMs: 300_000,
    staticPrices: {},
    ...overrides,
  };
  const config = { get: vi.fn().mockReturnValue(settings) } as unknown as ConfigService;
  return new PriceOracleService(config);
}

describe('PriceOracleService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('getQuote', () => {
    it('returns a unit quote when the asset already is the base currency', async () => {
      const service = oracle();
      const quote = await service.getQuote('USDC', 'USDC');
      expect(quote.price).toBe(1);
      expect(quote.asset).toBe('USDC');
    });

    it('uses the static price table when configured', async () => {
      const service = oracle({ staticPrices: { XLM: 0.25 } });
      const quote = await service.getQuote('XLM', 'USD');
      expect(quote).toMatchObject({ asset: 'XLM', base: 'USD', price: 0.25, source: 'static' });
    });

    it('fails closed when no price source is configured', async () => {
      const service = oracle();
      await expect(service.getQuote('XLM', 'USD')).rejects.toBeInstanceOf(
        PriceUnavailableException,
      );
    });

    it('reads a quote from the http oracle', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          quotes: { XLM: { price: 0.11, asOf: new Date().toISOString() } },
        }),
      }) as unknown as typeof fetch;

      const service = oracle({ enabled: true, url: 'https://prices.example/v1' });
      const quote = await service.getQuote('XLM', 'USD');

      expect(quote).toMatchObject({ asset: 'XLM', base: 'USD', price: 0.11, source: 'http' });
      const requested = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(requested).toContain('base=USD');
      expect(requested).toContain('assets=XLM');
    });

    it('rejects a stale quote', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          quotes: {
            XLM: { price: 0.11, asOf: new Date(Date.now() - 3_600_000).toISOString() },
          },
        }),
      }) as unknown as typeof fetch;

      const service = oracle({ enabled: true, url: 'https://prices.example/v1', maxAgeMs: 1_000 });
      await expect(service.getQuote('XLM', 'USD')).rejects.toMatchObject({
        reason: 'stale',
      });
    });

    it('rejects an invalid price', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          quotes: { XLM: { price: 0, asOf: new Date().toISOString() } },
        }),
      }) as unknown as typeof fetch;

      const service = oracle({ enabled: true, url: 'https://prices.example/v1' });
      await expect(service.getQuote('XLM', 'USD')).rejects.toMatchObject({ reason: 'invalid' });
    });

    it('rejects a missing quote', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ quotes: {} }),
      }) as unknown as typeof fetch;

      const service = oracle({ enabled: true, url: 'https://prices.example/v1' });
      await expect(service.getQuote('XLM', 'USD')).rejects.toMatchObject({ reason: 'invalid' });
    });

    it('reports an http failure as unavailable', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({}),
      }) as unknown as typeof fetch;

      const service = oracle({ enabled: true, url: 'https://prices.example/v1' });
      await expect(service.getQuote('XLM', 'USD')).rejects.toMatchObject({ reason: 'unavailable' });
    });
  });

  describe('convert', () => {
    it('multiplies the amount with the quote', async () => {
      const service = oracle({ staticPrices: { XLM: 0.25 } });
      await expect(service.convert(100, 'XLM', 'USD')).resolves.toBe(25);
    });

    it('never converts an unknown price to zero', async () => {
      const service = oracle();
      await expect(service.convert(100, 'XLM', 'USD')).rejects.toBeInstanceOf(
        PriceUnavailableException,
      );
    });

    it('converts an issued asset by its code', async () => {
      const service = oracle({ staticPrices: { USDC: 1 } });
      await expect(service.convert(42, `USDC:${ISSUER}`, 'USD')).resolves.toBe(42);
    });
  });
});
