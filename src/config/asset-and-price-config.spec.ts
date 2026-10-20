import { describe, expect, it } from 'vitest';
import { parseAnchorAssets } from './stellar.config';
import { parseStaticPrices } from './price-oracle.config';
import { assertValidEnvironment } from './env.validation';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** The smallest environment that satisfies every required key. */
const REQUIRED_ENV = {
  DATABASE_URL: 'postgresql://astroid:astroid@localhost:5432/astroid',
  JWT_ACCESS_SECRET: 'access-secret-at-least-16-chars',
  JWT_REFRESH_SECRET: 'refresh-secret-at-least-16-chars',
  AI_PROVIDER_KEY: 'nvapi-test-key',
} as const;

describe('parseAnchorAssets', () => {
  it('parses an empty list into an empty map', () => {
    expect(parseAnchorAssets('')).toEqual({});
  });

  it('parses a CODE=ISSUER pair and upper-cases the code', () => {
    expect(parseAnchorAssets(`usdc=${ISSUER}`)).toEqual({ USDC: ISSUER });
  });

  it('parses several pairs and ignores blank entries', () => {
    expect(parseAnchorAssets(`USDC=${ISSUER}, , EUR=${ISSUER}`)).toEqual({
      USDC: ISSUER,
      EUR: ISSUER,
    });
  });

  it('rejects an entry without an issuer', () => {
    expect(() => parseAnchorAssets('USDC')).toThrow(/expected CODE=ISSUER/);
  });

  it('rejects a malformed issuer address', () => {
    expect(() => parseAnchorAssets('USDC=not-an-address')).toThrow(/Stellar account address/);
  });

  it('rejects a malformed asset code', () => {
    expect(() => parseAnchorAssets(`TOO_LONG_ASSET_CODE=${ISSUER}`)).toThrow(
      /asset code must be 1-12/,
    );
  });
});

describe('parseStaticPrices', () => {
  it('parses an empty list into an empty map', () => {
    expect(parseStaticPrices('')).toEqual({});
  });

  it('parses an ASSET=PRICE pair and upper-cases the asset', () => {
    expect(parseStaticPrices('xlm=0.11')).toEqual({ XLM: 0.11 });
  });

  it('parses several pairs and ignores blank entries', () => {
    expect(parseStaticPrices('XLM=0.11, , USDC=1')).toEqual({ XLM: 0.11, USDC: 1 });
  });

  it('rejects an entry without a price', () => {
    expect(() => parseStaticPrices('XLM')).toThrow(/expected ASSET=PRICE/);
  });

  it('rejects a non-numeric price', () => {
    expect(() => parseStaticPrices('XLM=abc')).toThrow(/price must be a positive number/);
  });

  it('rejects a zero price so a missing quote can never be treated as free', () => {
    expect(() => parseStaticPrices('XLM=0')).toThrow(/price must be a positive number/);
  });
});

describe('audit and price oracle environment variables', () => {
  it('applies the documented audit archival defaults', () => {
    const env = assertValidEnvironment({ ...REQUIRED_ENV });

    expect(env.AUDIT_ARCHIVE_ENABLED).toBe(true);
    expect(env.AUDIT_ARCHIVE_RETENTION_DAYS).toBe(30);
    expect(env.AUDIT_ARCHIVE_BATCH_SIZE).toBe(500);
    expect(env.AUDIT_ARCHIVE_MAX_BATCHES).toBe(20);
    expect(env.AUDIT_RETENTION_DAYS).toBe(90);
  });

  it('applies the documented price oracle defaults', () => {
    const env = assertValidEnvironment({ ...REQUIRED_ENV });

    expect(env.PRICE_ORACLE_ENABLED).toBe(false);
    expect(env.PRICE_ORACLE_URL).toBe('');
    expect(env.PRICE_ORACLE_TIMEOUT_MS).toBe(3000);
    expect(env.PRICE_ORACLE_MAX_AGE_MS).toBe(300000);
    expect(env.PRICE_ORACLE_STATIC_PRICES).toBe('');
  });

  it('rejects an archive retention that is not below the hard-delete retention', () => {
    expect(() =>
      assertValidEnvironment({
        ...REQUIRED_ENV,
        AUDIT_ARCHIVE_RETENTION_DAYS: '90',
        AUDIT_RETENTION_DAYS: '90',
      }),
    ).toThrow(/must be lower than AUDIT_RETENTION_DAYS/);
  });

  it('rejects a non-positive batch size', () => {
    expect(() =>
      assertValidEnvironment({ ...REQUIRED_ENV, AUDIT_ARCHIVE_BATCH_SIZE: '0' }),
    ).toThrow();
  });

  it('rejects a non-positive price oracle timeout', () => {
    expect(() =>
      assertValidEnvironment({ ...REQUIRED_ENV, PRICE_ORACLE_TIMEOUT_MS: '0' }),
    ).toThrow();
  });

  it('accepts the anchor asset list', () => {
    const env = assertValidEnvironment({
      ...REQUIRED_ENV,
      STELLAR_ANCHOR_ASSETS: `USDC=${ISSUER}`,
    });

    expect(env.STELLAR_ANCHOR_ASSETS).toBe(`USDC=${ISSUER}`);
  });
});
