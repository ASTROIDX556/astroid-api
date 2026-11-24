import { describe, it, expect } from 'vitest';
import { ArgumentMetadata } from '@nestjs/common';
import { StellarAddressPipe } from './stellar-address.pipe';
import { stellarEd25519PublicKeySchema } from './stellar-address.schema';
import { ValidationException } from '../exceptions/domain.exception';

const VALID_G = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';
const VALID_C = 'CBRW63TUOJQWG5DBMRSHEMJSGM2DKNRXHA4TAMJSGM2DKNRXHA4TAJKY';
const BAD_CHECKSUM_G = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const metadata: ArgumentMetadata = { type: 'query', metatype: String };

describe('StellarAddressPipe (default: address schema)', () => {
  const pipe = new StellarAddressPipe();

  it('passes through a well-formed G… address', () => {
    expect(pipe.transform(VALID_G, metadata)).toBe(VALID_G);
  });

  it('passes through a well-formed C… contract id', () => {
    expect(pipe.transform(VALID_C, metadata)).toBe(VALID_C);
  });

  it('throws on empty/undefined/null input', () => {
    for (const value of ['', undefined, null]) {
      try {
        pipe.transform(value, metadata);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationException);
        expect((error as ValidationException).message).toBe('Stellar address is required');
      }
    }
  });

  it('throws on a checksum-invalid address with descriptive details', () => {
    try {
      pipe.transform(BAD_CHECKSUM_G, metadata);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationException);
      const details = (error as ValidationException).details as Array<{ path: string; message: string }>;
      expect(details).toBeDefined();
      expect(details.length).toBeGreaterThan(0);
      expect(details[0].message).toContain('checksum');
    }
  });

  it('throws on a malformed prefix', () => {
    expect(() => pipe.transform(`X${VALID_G.slice(1)}`, metadata)).toThrow();
  });

  it('throws on a lowercase address', () => {
    expect(() => pipe.transform(VALID_G.toLowerCase(), metadata)).toThrow();
  });
});

describe('StellarAddressPipe (narrowed to Ed25519 public keys)', () => {
  const pipe = new StellarAddressPipe(stellarEd25519PublicKeySchema);

  it('passes through a G… address', () => {
    expect(pipe.transform(VALID_G, metadata)).toBe(VALID_G);
  });

  it('rejects a contract ID under the narrowed schema', () => {
    expect(() => pipe.transform(VALID_C, metadata)).toThrow(ValidationException);
  });
});