import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  stellarEd25519PublicKeySchema,
  stellarContractIdSchema,
  stellarMed25519PublicKeySchema,
  stellarPublicKeySchema,
  stellarAddressSchema,
} from './stellar-address.schema';

// Real, valid Stellar strkeys (generated/verified with @stellar/stellar-sdk).
const VALID_G =
  'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';
const VALID_C =
  'CBRW63TUOJQWG5DBMRSHEMJSGM2DKNRXHA4TAMJSGM2DKNRXHA4TAJKY';
const VALID_M =
  'MADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA6OSU';

// 56 'A's — correct length, valid base32 characters, but a bad checksum.
const BAD_CHECKSUM_G = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BAD_CHECKSUM_C = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function schemaIssues(schema: z.ZodTypeAny, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.message);
}

describe('stellarEd25519PublicKeySchema', () => {
  it('accepts a well-formed G… public key', () => {
    expect(stellarEd25519PublicKeySchema.parse(VALID_G)).toBe(VALID_G);
  });

  it('rejects a wrong prefix', () => {
    const issues = schemaIssues(stellarEd25519PublicKeySchema, `A${VALID_G.slice(1)}`);
    expect(issues).toContainEqual(expect.stringContaining("must start with 'G'"));
  });

  it('rejects a contract ID (C…) under the public-key schema', () => {
    const issues = schemaIssues(stellarEd25519PublicKeySchema, VALID_C);
    expect(issues).toContainEqual(expect.stringContaining("must start with 'G'"));
  });

  it('rejects an empty string', () => {
    expect(stellarEd25519PublicKeySchema.safeParse('').success).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(stellarEd25519PublicKeySchema.safeParse(123).success).toBe(false);
  });

  it('rejects a value that is too short', () => {
    const issues = schemaIssues(stellarEd25519PublicKeySchema, VALID_G.slice(0, 55));
    expect(issues).toContainEqual(expect.stringContaining('expected exactly 56 characters, got 55'));
  });

  it('rejects a value that is too long', () => {
    const issues = schemaIssues(stellarEd25519PublicKeySchema, `${VALID_G}A`);
    expect(issues).toContainEqual(expect.stringContaining('expected exactly 56 characters, got 57'));
  });

  it('rejects lowercase base32 characters', () => {
    const issues = schemaIssues(stellarEd25519PublicKeySchema, VALID_G.toLowerCase());
    expect(issues).toContainEqual(expect.stringContaining('uppercase base32'));
  });

  it('rejects characters outside the base32 alphabet (0, 1, I, O)', () => {
    for (const bad of ['G' + `A`.repeat(54) + '0', 'G' + `A`.repeat(54) + '1', 'G' + `A`.repeat(54) + 'I', 'G' + `A`.repeat(54) + 'O']) {
      expect(stellarEd25519PublicKeySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects a correct-length checksum-invalid public key', () => {
    const issues = schemaIssues(stellarEd25519PublicKeySchema, BAD_CHECKSUM_G);
    expect(issues).toContainEqual(expect.stringContaining('checksum'));
  });
});

describe('stellarContractIdSchema', () => {
  it('accepts a well-formed C… contract ID', () => {
    expect(stellarContractIdSchema.parse(VALID_C)).toBe(VALID_C);
  });

  it('rejects a public key (G…) under the contract schema', () => {
    const issues = schemaIssues(stellarContractIdSchema, VALID_G);
    expect(issues).toContainEqual(expect.stringContaining("must start with 'C'"));
  });

  it('rejects a wrong length', () => {
    const issues = schemaIssues(stellarContractIdSchema, VALID_C.slice(0, 55));
    expect(issues).toContainEqual(expect.stringContaining('expected exactly 56 characters, got 55'));
  });

  it('rejects lowercase characters', () => {
    expect(stellarContractIdSchema.safeParse(VALID_C.toLowerCase()).success).toBe(false);
  });

  it('rejects a correct-length checksum-invalid contract id', () => {
    const issues = schemaIssues(stellarContractIdSchema, BAD_CHECKSUM_C);
    expect(issues).toContainEqual(expect.stringContaining('checksum'));
  });
});

describe('stellarMed25519PublicKeySchema', () => {
  it('accepts a well-formed M… multiplexed address', () => {
    expect(stellarMed25519PublicKeySchema.parse(VALID_M)).toBe(VALID_M);
  });

  it('rejects a value with the wrong (G…) prefix', () => {
    expect(stellarMed25519PublicKeySchema.safeParse(VALID_G).success).toBe(false);
  });

  it('rejects a wrong M… length', () => {
    const issues = schemaIssues(stellarMed25519PublicKeySchema, VALID_M.slice(0, -1));
    expect(issues).toContainEqual(expect.stringContaining('expected exactly 69 characters, got 68'));
  });
});

describe('stellarPublicKeySchema (combined G… | M…)', () => {
  it('accepts both G… and M… addresses', () => {
    expect(stellarPublicKeySchema.parse(VALID_G)).toBe(VALID_G);
    expect(stellarPublicKeySchema.parse(VALID_M)).toBe(VALID_M);
  });

  it('rejects a contract ID (payments cannot target contracts)', () => {
    expect(stellarPublicKeySchema.safeParse(VALID_C).success).toBe(false);
  });

  it('rejects a checksum-invalid G… key', () => {
    expect(stellarPublicKeySchema.safeParse(BAD_CHECKSUM_G).success).toBe(false);
  });
});

describe('stellarAddressSchema (combined G… | M… | C…)', () => {
  it('accepts a G…, M… and C… address', () => {
    expect(stellarAddressSchema.parse(VALID_G)).toBe(VALID_G);
    expect(stellarAddressSchema.parse(VALID_M)).toBe(VALID_M);
    expect(stellarAddressSchema.parse(VALID_C)).toBe(VALID_C);
  });

  it('rejects a lowercase G… address', () => {
    expect(stellarAddressSchema.safeParse(VALID_G.toLowerCase()).success).toBe(false);
  });

  it('rejects an invalid-checksum key', () => {
    expect(stellarAddressSchema.safeParse(BAD_CHECKSUM_G).success).toBe(false);
    expect(stellarAddressSchema.safeParse(BAD_CHECKSUM_C).success).toBe(false);
  });

  it('rejects a malformed prefix (random leading letter)', () => {
    expect(stellarAddressSchema.safeParse(`X${VALID_G.slice(1)}`).success).toBe(false);
  });

  it('rejects a non-string, null, or undefined', () => {
    expect(stellarAddressSchema.safeParse(123).success).toBe(false);
    expect(stellarAddressSchema.safeParse(null).success).toBe(false);
    expect(stellarAddressSchema.safeParse(undefined).success).toBe(false);
    expect(stellarAddressSchema.safeParse('').success).toBe(false);
  });
});