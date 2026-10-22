import { describe, expect, it } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import { ValidationException } from '../exceptions/domain.exception';
import {
  MAX_SPLIT_WEIGHT_TOTAL,
  splitConfigurationSchema,
  splitReceiverSchema,
  validateSplitConfiguration,
} from './split-configuration.schema';

/** Deterministic, checksum-valid Stellar Ed25519 addresses. */
const receiver = (fill: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, fill));

const VALID_G = receiver(1);
const OTHER_G = receiver(2);
const THIRD_G = receiver(3);

// 56 'A's — correct length/charset for a G… key but a broken checksum.
const BAD_CHECKSUM_G = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// A contract ID (C…) — valid Stellar strkey, but not a payment destination.
const VALID_CONTRACT =
  'CBRW63TUOJQWG5DBMRSHEMJSGM2DKNRXHA4TAMJSGM2DKNRXHA4TAJKY';

function schemaIssues(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = splitConfigurationSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
}

describe('splitReceiverSchema', () => {
  it('accepts a valid receiver with a positive integer weight', () => {
    expect(splitReceiverSchema.parse({ address: VALID_G, weight: 1 })).toEqual({
      address: VALID_G,
      weight: 1,
    });
  });

  it('rejects a malformed address (bad checksum)', () => {
    const result = splitReceiverSchema.safeParse({ address: BAD_CHECKSUM_G, weight: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a contract ID — receivers must be accounts', () => {
    const result = splitReceiverSchema.safeParse({ address: VALID_CONTRACT, weight: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a weight of zero', () => {
    const result = splitReceiverSchema.safeParse({ address: VALID_G, weight: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('greater than zero');
    }
  });

  it('rejects a negative weight', () => {
    expect(splitReceiverSchema.safeParse({ address: VALID_G, weight: -5 }).success).toBe(false);
  });

  it('rejects a non-integer weight', () => {
    expect(splitReceiverSchema.safeParse({ address: VALID_G, weight: 1.5 }).success).toBe(false);
  });

  it('rejects a missing weight', () => {
    expect(splitReceiverSchema.safeParse({ address: VALID_G }).success).toBe(false);
  });
});

describe('splitConfigurationSchema', () => {
  it('accepts a single-receiver split', () => {
    const parsed = splitConfigurationSchema.parse([{ address: VALID_G, weight: 1_000_000 }]);
    expect(parsed).toEqual([{ address: VALID_G, weight: 1_000_000 }]);
  });

  it('accepts multiple receivers with distinct addresses', () => {
    const parsed = splitConfigurationSchema.parse([
      { address: VALID_G, weight: 50 },
      { address: OTHER_G, weight: 30 },
      { address: THIRD_G, weight: 20 },
    ]);
    expect(parsed).toHaveLength(3);
  });

  it('rejects an empty split', () => {
    const issues = schemaIssues([]);
    expect(issues.map((issue) => issue.message)).toContainEqual(
      expect.stringContaining('at least one receiver'),
    );
  });

  it('rejects a non-array configuration', () => {
    expect(splitConfigurationSchema.safeParse({ address: VALID_G, weight: 1 }).success).toBe(false);
    expect(splitConfigurationSchema.safeParse(undefined).success).toBe(false);
    expect(splitConfigurationSchema.safeParse('splits').success).toBe(false);
  });

  it('rejects duplicate receiver addresses with a descriptive message', () => {
    const issues = schemaIssues([
      { address: VALID_G, weight: 10 },
      { address: VALID_G, weight: 20 },
    ]);
    const duplicate = issues.find((issue) => issue.message.includes('Duplicate receiver'));
    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toContain(VALID_G);
    expect(duplicate?.path).toEqual([1, 'address']);
  });

  it('rejects a malformed receiver address', () => {
    const issues = schemaIssues([{ address: BAD_CHECKSUM_G, weight: 1 }]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].path).toEqual([0, 'address']);
  });

  it('accepts a total weight exactly at the precision limit', () => {
    const parsed = splitConfigurationSchema.parse([
      { address: VALID_G, weight: MAX_SPLIT_WEIGHT_TOTAL },
    ]);
    expect(parsed[0].weight).toBe(MAX_SPLIT_WEIGHT_TOTAL);
  });

  it('accepts weights summing exactly to the precision limit across receivers', () => {
    const parsed = splitConfigurationSchema.parse([
      { address: VALID_G, weight: MAX_SPLIT_WEIGHT_TOTAL - 1 },
      { address: OTHER_G, weight: 1 },
    ]);
    expect(parsed).toHaveLength(2);
  });

  it('rejects a single weight above the precision limit', () => {
    const issues = schemaIssues([{ address: VALID_G, weight: MAX_SPLIT_WEIGHT_TOTAL + 1 }]);
    expect(issues.map((issue) => issue.message)).toContainEqual(
      expect.stringContaining('maximum precision limit'),
    );
  });

  it('rejects a total weight above the precision limit', () => {
    const issues = schemaIssues([
      { address: VALID_G, weight: MAX_SPLIT_WEIGHT_TOTAL },
      { address: OTHER_G, weight: 1 },
    ]);
    expect(issues.map((issue) => issue.message)).toContainEqual(
      expect.stringContaining(`Split weight total ${MAX_SPLIT_WEIGHT_TOTAL + 1} exceeds`),
    );
  });
});

describe('validateSplitConfiguration', () => {
  it('returns the parsed configuration on success', () => {
    const result = validateSplitConfiguration([
      { address: VALID_G, weight: 60 },
      { address: OTHER_G, weight: 40 },
    ]);
    expect(result).toEqual([
      { address: VALID_G, weight: 60 },
      { address: OTHER_G, weight: 40 },
    ]);
  });

  it('throws a descriptive ValidationException listing every failed rule', () => {
    let thrown: unknown;
    try {
      validateSplitConfiguration([
        { address: BAD_CHECKSUM_G, weight: 1 },
        { address: OTHER_G, weight: 0 },
        { address: OTHER_G, weight: MAX_SPLIT_WEIGHT_TOTAL },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationException);
    const exception = thrown as ValidationException;
    expect(exception.message).toContain('Invalid split configuration');
    expect(exception.message).toContain('Duplicate receiver address');
    expect(exception.message).toContain('greater than zero');

    const details = exception.details as Array<{ path: string; message: string }>;
    expect(details.length).toBeGreaterThanOrEqual(3);
    expect(details.map((detail) => detail.path)).toContain('1.weight');
  });

  it('throws for an empty split', () => {
    expect(() => validateSplitConfiguration([])).toThrow(ValidationException);
    expect(() => validateSplitConfiguration([])).toThrow('at least one receiver');
  });
});
