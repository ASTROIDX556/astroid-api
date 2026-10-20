import { describe, expect, it } from 'vitest';
import {
  ASSET_CODE_MAX_LENGTH,
  assetCodeOf,
  isNativeAsset,
  isValidAssetCode,
  isValidIssuerAddress,
  parseAssetIdentifier,
} from './asset.util';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('parseAssetIdentifier', () => {
  it('parses the native asset', () => {
    const parsed = parseAssetIdentifier('XLM');
    expect(parsed).toEqual({ code: 'XLM', canonical: 'XLM', native: true });
  });

  it('parses a bare ticker', () => {
    const parsed = parseAssetIdentifier('usdc');
    expect(parsed).toEqual({ code: 'USDC', canonical: 'USDC', native: false });
  });

  it('parses a credit asset with its issuer', () => {
    const parsed = parseAssetIdentifier(`USDC:${ISSUER}`);
    expect(parsed).toEqual({
      code: 'USDC',
      issuer: ISSUER,
      canonical: `USDC:${ISSUER}`,
      native: false,
    });
  });

  it('rejects an empty identifier', () => {
    expect(() => parseAssetIdentifier('  ')).toThrow(/must not be empty/);
  });

  it('rejects a code longer than the Stellar maximum', () => {
    expect(() => parseAssetIdentifier('A'.repeat(ASSET_CODE_MAX_LENGTH + 1))).toThrow(
      /1-12 alphanumeric characters/,
    );
  });

  it('rejects a malformed issuer', () => {
    expect(() => parseAssetIdentifier('USDC:not-an-issuer')).toThrow(
      /issuer must be a Stellar account address/,
    );
  });

  it('rejects the native asset with an issuer', () => {
    expect(() => parseAssetIdentifier(`XLM:${ISSUER}`)).toThrow(/has no issuer/);
  });
});

describe('assetCodeOf', () => {
  it('returns the code without the issuer', () => {
    expect(assetCodeOf(`USDC:${ISSUER}`)).toBe('USDC');
    expect(assetCodeOf('XLM')).toBe('XLM');
  });
});

describe('isNativeAsset', () => {
  it('is true only for the native asset', () => {
    expect(isNativeAsset('XLM')).toBe(true);
    expect(isNativeAsset('USDC')).toBe(false);
    expect(isNativeAsset(`USDC:${ISSUER}`)).toBe(false);
  });
});

describe('isValidAssetCode / isValidIssuerAddress', () => {
  it('accepts alphanumeric codes only', () => {
    expect(isValidAssetCode('USDC')).toBe(true);
    expect(isValidAssetCode('US-DC')).toBe(false);
    expect(isValidAssetCode('')).toBe(false);
  });

  it('accepts Stellar account addresses only', () => {
    expect(isValidIssuerAddress(ISSUER)).toBe(true);
    expect(isValidIssuerAddress('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4K')).toBe(
      false,
    );
    expect(isValidIssuerAddress('not-an-address')).toBe(false);
  });
});
