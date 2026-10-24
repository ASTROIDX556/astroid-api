import { describe, it, expect } from 'vitest';
import { createTransactionSchema, simulateTransactionSchema } from './transaction.dto';

describe('createTransactionSchema memo validation', () => {
  const baseInput = {
    walletId: '550e8400-e29b-41d4-a716-446655440000',
    amount: '10.0000000',
    recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
  };

  describe('payment input validation', () => {
    it('accepts a complete payment payload with metadata', () => {
      expect(
        createTransactionSchema.parse({
          ...baseInput,
          metadata: { invoiceId: 'invoice-1' },
        }),
      ).toMatchObject({
        amount: '10.0000000',
        recipientAddress: baseInput.recipientAddress,
        metadata: { invoiceId: 'invoice-1' },
      });
    });

    it('rejects missing wallet identifiers and negative or zero amounts', () => {
      expect(() =>
        createTransactionSchema.parse({
          amount: '10',
          recipientAddress: baseInput.recipientAddress,
        }),
      ).toThrow();
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, amount: '-1' }),
      ).toThrow();
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, amount: '0' }),
      ).toThrow();
    });

    it('rejects malformed recipients and non-object metadata', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, recipientAddress: 'not-a-stellar-address' }),
      ).toThrow();
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, metadata: ['unexpected'] }),
      ).toThrow();
    });

    it('rejects an amount with more than seven decimal places', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, amount: '1.12345678' }),
      ).toThrow();
      expect(() =>
        simulateTransactionSchema.parse({
          ...baseInput,
          transfers: [{ asset: 'XLM', amount: '1.12345678' }],
        }),
      ).toThrow();
    });

    it('rejects a non-numeric amount', () => {
      expect(() => createTransactionSchema.parse({ ...baseInput, amount: 'abc' })).toThrow();
    });

    it('rejects a malformed asset identifier', () => {
      expect(() => createTransactionSchema.parse({ ...baseInput, asset: 'USDC:bad' })).toThrow();
      expect(() => createTransactionSchema.parse({ ...baseInput, asset: '' })).toThrow();
    });

    it('rejects non-JSON values nested in metadata', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          metadata: { nested: { unsupported: undefined } },
        }),
      ).toThrow();
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          metadata: { nested: [Number.NaN] },
        }),
      ).toThrow();
    });
  });

  describe('legacy string memo (TEXT type)', () => {
    it('accepts valid legacy memo', () => {
      const result = createTransactionSchema.parse({ ...baseInput, memo: 'hello' });
      expect(result.memo).toBe('hello');
    });

    it('accepts 28-byte memo', () => {
      const result = createTransactionSchema.parse({ ...baseInput, memo: 'a'.repeat(28) });
      expect(result.memo).toBe('a'.repeat(28));
    });

    it('rejects 29-byte memo', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, memo: 'a'.repeat(29) }),
      ).toThrow();
    });

    it('rejects empty string memo', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, memo: '' }),
      ).toThrow();
    });

    it('accepts multibyte memo within byte limit', () => {
      const emoji = '\u{1F600}'; // 4 bytes
      const text = emoji.repeat(7); // 28 bytes
      const result = createTransactionSchema.parse({ ...baseInput, memo: text });
      expect(result.memo).toBe(text);
    });

    it('rejects multibyte memo exceeding byte limit', () => {
      const emoji = '\u{1F600}'; // 4 bytes
      const text = emoji.repeat(8); // 32 bytes
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, memo: text }),
      ).toThrow();
    });
  });

  describe('typed memo (memoType + memoValue)', () => {
    it('accepts typed TEXT memo', () => {
      const result = createTransactionSchema.parse({
        ...baseInput,
        memoType: 'text',
        memoValue: 'hello',
      });
      expect(result.memoType).toBe('text');
      expect(result.memoValue).toBe('hello');
    });

    it('accepts typed ID memo', () => {
      const result = createTransactionSchema.parse({
        ...baseInput,
        memoType: 'id',
        memoValue: '12345',
      });
      expect(result.memoType).toBe('id');
      expect(result.memoValue).toBe('12345');
    });

    it('accepts typed HASH memo', () => {
      const hash = 'a'.repeat(64);
      const result = createTransactionSchema.parse({
        ...baseInput,
        memoType: 'hash',
        memoValue: hash,
      });
      expect(result.memoType).toBe('hash');
      expect(result.memoValue).toBe(hash);
    });

    it('accepts typed RETURN memo', () => {
      const hash = 'b'.repeat(64);
      const result = createTransactionSchema.parse({
        ...baseInput,
        memoType: 'return',
        memoValue: hash,
      });
      expect(result.memoType).toBe('return');
      expect(result.memoValue).toBe(hash);
    });

    it('rejects memoType without memoValue', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, memoType: 'text' }),
      ).toThrow('memoValue is required');
    });

    it('rejects typed TEXT memo exceeding 28 bytes', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'text',
          memoValue: 'a'.repeat(29),
        }),
      ).toThrow();
    });

    it('rejects typed ID memo with negative value', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'id',
          memoValue: '-1',
        }),
      ).toThrow();
    });

    it('rejects typed ID memo exceeding uint64 max', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'id',
          memoValue: '18446744073709551616',
        }),
      ).toThrow();
    });

    it('rejects typed HASH memo that is too short', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'hash',
          memoValue: 'a'.repeat(63),
        }),
      ).toThrow();
    });

    it('rejects typed HASH memo with non-hex characters', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'hash',
          memoValue: 'g' + 'a'.repeat(63),
        }),
      ).toThrow();
    });

    it('rejects unknown memoType', () => {
      expect(() =>
        createTransactionSchema.parse({
          ...baseInput,
          memoType: 'unknown',
          memoValue: 'test',
        }),
      ).toThrow();
    });

    it('accepts typed memo alongside legacy memo field', () => {
      const result = createTransactionSchema.parse({
        ...baseInput,
        memo: 'legacy',
        memoType: 'hash',
        memoValue: 'a'.repeat(64),
      });
      expect(result.memo).toBe('legacy');
      expect(result.memoType).toBe('hash');
      expect(result.memoValue).toBe('a'.repeat(64));
    });
  });

  describe('no memo', () => {
    it('accepts transaction without any memo', () => {
      const result = createTransactionSchema.parse(baseInput);
      expect(result.memo).toBeUndefined();
      expect(result.memoType).toBeUndefined();
      expect(result.memoValue).toBeUndefined();
    });
  });

  describe('strict mode', () => {
    it('rejects unknown fields', () => {
      expect(() =>
        createTransactionSchema.parse({ ...baseInput, unknown: 'field' }),
      ).toThrow();
    });
  });
});

describe('createTransactionSchema asset validation', () => {
  const baseInput = {
    walletId: '550e8400-e29b-41d4-a716-446655440000',
    amount: '10.0000000',
    recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
  };

  it('defaults to the native asset', () => {
    expect(createTransactionSchema.parse(baseInput).asset).toBe('XLM');
  });

  it('accepts a Stellar Anchor ticker', () => {
    expect(createTransactionSchema.parse({ ...baseInput, asset: 'USDC' }).asset).toBe('USDC');
  });

  it('accepts an issued asset in its canonical CODE:ISSUER form', () => {
    const asset = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    expect(createTransactionSchema.parse({ ...baseInput, asset }).asset).toBe(asset);
  });

  it('rejects an asset code that is too long', () => {
    expect(() =>
      createTransactionSchema.parse({ ...baseInput, asset: 'A'.repeat(13) }),
    ).toThrow();
  });

  it('rejects an issued asset with a malformed issuer', () => {
    expect(() =>
      createTransactionSchema.parse({ ...baseInput, asset: 'USDC:not-an-issuer' }),
    ).toThrow();
  });

  it('explains that a transaction moves a single asset when a transfers array is sent', () => {
    expect(() =>
      createTransactionSchema.parse({
        ...baseInput,
        transfers: [{ asset: 'XLM', amount: '1.0000000' }],
      }),
    ).toThrow('A transaction moves a single asset');
  });
});

describe('simulateTransactionSchema multi-asset payloads', () => {
  const baseInput = {
    walletId: '550e8400-e29b-41d4-a716-446655440000',
    recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
  };

  it('accepts a single-asset payload', () => {
    const parsed = simulateTransactionSchema.parse({
      ...baseInput,
      asset: 'XLM',
      amount: '10.0000000',
    });
    expect(parsed.amount).toBe('10.0000000');
    expect(parsed.transfers).toBeUndefined();
  });

  it('accepts a multi-asset payload', () => {
    const parsed = simulateTransactionSchema.parse({
      ...baseInput,
      transfers: [
        { asset: 'XLM', amount: '10.0000000' },
        { asset: 'USDC', amount: '25.5000000' },
      ],
    });
    expect(parsed.transfers).toHaveLength(2);
    expect(parsed.transfers?.[1]).toEqual({ asset: 'USDC', amount: '25.5000000' });
  });

  it('rejects a payload that mixes a single transfer with a transfers array', () => {
    expect(() =>
      simulateTransactionSchema.parse({
        ...baseInput,
        asset: 'XLM',
        amount: '10.0000000',
        transfers: [{ asset: 'USDC', amount: '1.0000000' }],
      }),
    ).toThrow('not both');
  });

  it('rejects a payload without any transfer', () => {
    expect(() => simulateTransactionSchema.parse(baseInput)).toThrow('amount is required');
  });

  it('rejects a transfers array with an invalid amount', () => {
    expect(() =>
      simulateTransactionSchema.parse({
        ...baseInput,
        transfers: [{ asset: 'USDC', amount: '0' }],
      }),
    ).toThrow();
  });

  it('rejects a transfers array with more than ten legs', () => {
    expect(() =>
      simulateTransactionSchema.parse({
        ...baseInput,
        transfers: Array.from({ length: 11 }, () => ({ asset: 'USDC', amount: '1.0000000' })),
      }),
    ).toThrow();
  });
});
