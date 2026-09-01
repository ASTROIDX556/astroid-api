import { describe, it, expect } from 'vitest';
import {
  stellarMemoSchema,
  textMemoValueSchema,
  idMemoValueSchema,
  hashMemoValueSchema,
  returnMemoValueSchema,
  typedMemoSchema,
  legacyMemoSchema,
  stellarMemoTypeSchema,
} from './stellar-memo.schema';

describe('stellarMemoTypeSchema', () => {
  it('accepts valid memo types', () => {
    expect(stellarMemoTypeSchema.parse('text')).toBe('text');
    expect(stellarMemoTypeSchema.parse('id')).toBe('id');
    expect(stellarMemoTypeSchema.parse('hash')).toBe('hash');
    expect(stellarMemoTypeSchema.parse('return')).toBe('return');
  });

  it('rejects invalid memo types', () => {
    expect(() => stellarMemoTypeSchema.parse('TEXT')).toThrow();
    expect(() => stellarMemoTypeSchema.parse('invalid')).toThrow();
    expect(() => stellarMemoTypeSchema.parse('')).toThrow();
    expect(() => stellarMemoTypeSchema.parse('none')).toThrow();
  });
});

describe('textMemoValueSchema', () => {
  it('accepts valid text memos', () => {
    expect(textMemoValueSchema.parse('hello')).toBe('hello');
    expect(textMemoValueSchema.parse('Invoice #12345')).toBe('Invoice #12345');
    expect(textMemoValueSchema.parse('a')).toBe('a');
  });

  it('accepts text at exactly 28 bytes', () => {
    const text28 = 'a'.repeat(28);
    expect(textMemoValueSchema.parse(text28)).toBe(text28);
  });

  it('rejects empty strings', () => {
    expect(() => textMemoValueSchema.parse('')).toThrow('cannot be empty');
  });

  it('rejects text exceeding 28 bytes', () => {
    const text29 = 'a'.repeat(29);
    expect(() => textMemoValueSchema.parse(text29)).toThrow('28 bytes');
  });

  it('rejects multibyte text exceeding 28 bytes', () => {
    // Each emoji is 4 bytes in UTF-8
    const emoji = '\u{1F600}'; // 4 bytes
    const text = emoji.repeat(7); // 28 bytes — boundary
    expect(textMemoValueSchema.parse(text)).toBe(text);

    const textOver = emoji.repeat(8); // 32 bytes — over limit
    expect(() => textMemoValueSchema.parse(textOver)).toThrow('28 bytes');
  });

  it('rejects non-string values', () => {
    expect(() => textMemoValueSchema.parse(123)).toThrow();
    expect(() => textMemoValueSchema.parse(null)).toThrow();
    expect(() => textMemoValueSchema.parse(undefined)).toThrow();
  });
});

describe('idMemoValueSchema', () => {
  it('accepts valid ID memos', () => {
    expect(idMemoValueSchema.parse('0')).toBe('0');
    expect(idMemoValueSchema.parse('1')).toBe('1');
    expect(idMemoValueSchema.parse('12345')).toBe('12345');
    expect(idMemoValueSchema.parse('18446744073709551615')).toBe('18446744073709551615');
  });

  it('accepts maximum uint64 value', () => {
    expect(idMemoValueSchema.parse('18446744073709551615')).toBe('18446744073709551615');
  });

  it('rejects values exceeding uint64 max', () => {
    expect(() => idMemoValueSchema.parse('18446744073709551616')).toThrow();
  });

  it('rejects negative values', () => {
    expect(() => idMemoValueSchema.parse('-1')).toThrow();
  });

  it('rejects non-integer strings', () => {
    expect(() => idMemoValueSchema.parse('1.5')).toThrow();
    expect(() => idMemoValueSchema.parse('abc')).toThrow();
    expect(() => idMemoValueSchema.parse('1e10')).toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => idMemoValueSchema.parse('')).toThrow();
  });

  it('rejects non-string values', () => {
    expect(() => idMemoValueSchema.parse(123)).toThrow();
    expect(() => idMemoValueSchema.parse(null)).toThrow();
  });
});

describe('hashMemoValueSchema', () => {
  it('accepts valid hash memos', () => {
    const hash = 'a'.repeat(64);
    expect(hashMemoValueSchema.parse(hash)).toBe(hash);
  });

  it('accepts hash with mixed hex characters', () => {
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    expect(hashMemoValueSchema.parse(hash)).toBe(hash);
  });

  it('rejects hash that is too short', () => {
    expect(() => hashMemoValueSchema.parse('a'.repeat(63))).toThrow();
  });

  it('rejects hash that is too long', () => {
    expect(() => hashMemoValueSchema.parse('a'.repeat(65))).toThrow();
  });

  it('rejects non-hex characters', () => {
    expect(() => hashMemoValueSchema.parse('g' + 'a'.repeat(63))).toThrow();
  });

  it('accepts uppercase hex characters (sanitizer normalizes to lowercase)', () => {
    const hash = 'A' + 'a'.repeat(63);
    expect(hashMemoValueSchema.parse(hash)).toBe(hash);
  });

  it('rejects empty strings', () => {
    expect(() => hashMemoValueSchema.parse('')).toThrow();
  });
});

describe('returnMemoValueSchema', () => {
  it('accepts valid return memos', () => {
    const hash = 'b'.repeat(64);
    expect(returnMemoValueSchema.parse(hash)).toBe(hash);
  });

  it('rejects return that is too short', () => {
    expect(() => returnMemoValueSchema.parse('b'.repeat(63))).toThrow();
  });

  it('rejects return that is too long', () => {
    expect(() => returnMemoValueSchema.parse('b'.repeat(65))).toThrow();
  });

  it('rejects non-hex characters', () => {
    expect(() => returnMemoValueSchema.parse('z' + 'b'.repeat(63))).toThrow();
  });
});

describe('typedMemoSchema', () => {
  it('accepts valid typed text memo', () => {
    const result = typedMemoSchema.parse({ type: 'text', value: 'hello' });
    expect(result).toEqual({ type: 'text', value: 'hello' });
  });

  it('accepts valid typed id memo', () => {
    const result = typedMemoSchema.parse({ type: 'id', value: '42' });
    expect(result).toEqual({ type: 'id', value: '42' });
  });

  it('accepts valid typed hash memo', () => {
    const hash = 'a'.repeat(64);
    const result = typedMemoSchema.parse({ type: 'hash', value: hash });
    expect(result).toEqual({ type: 'hash', value: hash });
  });

  it('accepts valid typed return memo', () => {
    const hash = 'b'.repeat(64);
    const result = typedMemoSchema.parse({ type: 'return', value: hash });
    expect(result).toEqual({ type: 'return', value: hash });
  });

  it('rejects typed memo with invalid value', () => {
    expect(() =>
      typedMemoSchema.parse({ type: 'text', value: '' }),
    ).toThrow();
    expect(() =>
      typedMemoSchema.parse({ type: 'id', value: '-1' }),
    ).toThrow();
    expect(() =>
      typedMemoSchema.parse({ type: 'hash', value: 'short' }),
    ).toThrow();
  });

  it('rejects unknown memo type', () => {
    expect(() =>
      typedMemoSchema.parse({ type: 'unknown', value: 'test' }),
    ).toThrow();
  });
});

describe('legacyMemoSchema', () => {
  it('accepts valid legacy memo strings', () => {
    expect(legacyMemoSchema.parse('hello')).toBe('hello');
    expect(legacyMemoSchema.parse('a')).toBe('a');
  });

  it('accepts 28-byte string', () => {
    expect(legacyMemoSchema.parse('a'.repeat(28))).toBe('a'.repeat(28));
  });

  it('rejects empty strings', () => {
    expect(() => legacyMemoSchema.parse('')).toThrow('cannot be empty');
  });

  it('rejects strings exceeding 28 bytes', () => {
    expect(() => legacyMemoSchema.parse('a'.repeat(29))).toThrow();
  });
});

describe('stellarMemoSchema (combined)', () => {
  it('transforms legacy string memo into typed format', () => {
    const result = stellarMemoSchema.parse('hello');
    expect(result).toEqual({ type: 'text', value: 'hello' });
  });

  it('passes through typed memo unchanged', () => {
    const input = { type: 'id' as const, value: '42' };
    const result = stellarMemoSchema.parse(input);
    expect(result).toEqual({ type: 'id', value: '42' });
  });

  it('rejects invalid string memo', () => {
    expect(() => stellarMemoSchema.parse('a'.repeat(29))).toThrow();
  });

  it('rejects invalid typed memo', () => {
    expect(() => stellarMemoSchema.parse({ type: 'hash', value: 'short' })).toThrow();
  });
});
