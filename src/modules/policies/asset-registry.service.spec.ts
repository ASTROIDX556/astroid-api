import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AssetRegistryService } from './asset-registry.service';
import { ValidationException } from '../../common/exceptions/domain.exception';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function registry(anchorAssets: Record<string, string> = {}): AssetRegistryService {
  const config = {
    get: vi.fn().mockReturnValue({ anchorAssets }),
  } as unknown as ConfigService;
  return new AssetRegistryService(config);
}

describe('AssetRegistryService', () => {
  let service: AssetRegistryService;

  beforeEach(() => {
    service = registry();
  });

  describe('canonicalize', () => {
    it('keeps the native asset untouched', () => {
      expect(service.canonicalize('XLM')).toBe('XLM');
    });

    it('keeps an explicit credit asset untouched', () => {
      expect(service.canonicalize(`USDC:${ISSUER}`)).toBe(`USDC:${ISSUER}`);
    });

    it('expands a configured Stellar Anchor ticker to CODE:ISSUER', () => {
      const anchored = registry({ USDC: ISSUER });
      expect(anchored.canonicalize('USDC')).toBe(`USDC:${ISSUER}`);
      expect(anchored.canonicalize('usdc')).toBe(`USDC:${ISSUER}`);
    });

    it('keeps an unknown ticker as-is so the network client reports it', () => {
      expect(service.canonicalize('FOO')).toBe('FOO');
    });

    it('rejects a malformed identifier with a validation error', () => {
      expect(() => service.canonicalize('USDC:bad-issuer')).toThrow(ValidationException);
    });

    it('rejects an empty identifier with a validation error', () => {
      expect(() => service.canonicalize('')).toThrow(ValidationException);
      expect(() => service.canonicalize('   ')).toThrow(ValidationException);
    });

    it('rejects an asset code longer than the Stellar maximum', () => {
      expect(() => service.canonicalize('ABCDEFGHIJKLM')).toThrow(ValidationException);
    });

    it('rejects the native asset with an issuer', () => {
      expect(() => service.canonicalize(`XLM:${ISSUER}`)).toThrow(ValidationException);
    });
  });

  describe('isAnchorAsset / issuerFor', () => {
    it('reports whether a ticker is a configured anchor', () => {
      const anchored = registry({ USDC: ISSUER });
      expect(anchored.isAnchorAsset('USDC')).toBe(true);
      expect(anchored.isAnchorAsset('EURC')).toBe(false);
      expect(anchored.isAnchorAsset('XLM')).toBe(false);
    });

    it('resolves the issuer of a configured anchor', () => {
      const anchored = registry({ USDC: ISSUER });
      expect(anchored.issuerFor('usdc')).toBe(ISSUER);
      expect(anchored.issuerFor('EURC')).toBeUndefined();
    });
  });
});
