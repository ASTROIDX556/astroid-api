import { describe, it, expect } from 'vitest';
import {
  sanitizeTextMemo,
  sanitizeIdMemo,
  sanitizeHashMemo,
  sanitizeReturnMemo,
  sanitizeMemo,
} from './stellar-memo.sanitizer';

describe('sanitizeTextMemo', () => {
  it('returns trimmed text unchanged', () => {
    expect(sanitizeTextMemo('hello')).toBe('hello');
  });

  it('trims whitespace', () => {
    expect(sanitizeTextMemo('  hello  ')).toBe('hello');
  });

  it('trims tabs and newlines', () => {
    expect(sanitizeTextMemo('\t\nhello\t\n')).toBe('hello');
  });

  it('rejects empty string', () => {
    expect(() => sanitizeTextMemo('')).toThrow('cannot be empty');
  });

  it('rejects whitespace-only string', () => {
    expect(() => sanitizeTextMemo('   ')).toThrow('cannot be empty');
  });

  it('rejects text exceeding 28 bytes', () => {
    expect(() => sanitizeTextMemo('a'.repeat(29))).toThrow('28 bytes');
  });

  it('accepts text at exactly 28 bytes', () => {
    expect(sanitizeTextMemo('a'.repeat(28))).toBe('a'.repeat(28));
  });

  it('rejects null bytes', () => {
    expect(() => sanitizeTextMemo('hello\0world')).toThrow('null bytes');
  });

  it('handles multibyte characters correctly', () => {
    // Each emoji is 4 bytes
    const emoji = '\u{1F600}';
    const text = emoji.repeat(7); // 28 bytes
    expect(sanitizeTextMemo(text)).toBe(text);
  });
});

describe('sanitizeIdMemo', () => {
  it('returns valid ID unchanged', () => {
    expect(sanitizeIdMemo('42')).toBe('42');
  });

  it('removes leading zeros', () => {
    expect(sanitizeIdMemo('007')).toBe('7');
  });

  it('preserves zero itself', () => {
    expect(sanitizeIdMemo('0')).toBe('0');
  });

  it('preserves the maximum uint64 value', () => {
    expect(sanitizeIdMemo('18446744073709551615')).toBe('18446744073709551615');
  });

  it('rejects values exceeding uint64 max', () => {
    expect(() => sanitizeIdMemo('18446744073709551616')).toThrow('range');
  });

  it('rejects negative values', () => {
    expect(() => sanitizeIdMemo('-1')).toThrow('digits');
  });

  it('rejects non-numeric strings', () => {
    expect(() => sanitizeIdMemo('abc')).toThrow('digits');
  });

  it('rejects decimal strings', () => {
    expect(() => sanitizeIdMemo('1.5')).toThrow('digits');
  });

  it('trims whitespace', () => {
    expect(sanitizeIdMemo('  42  ')).toBe('42');
  });
});

describe('sanitizeHashMemo', () => {
  it('returns lowercase hex unchanged', () => {
    const hash = 'a'.repeat(64);
    expect(sanitizeHashMemo(hash)).toBe(hash);
  });

  it('converts uppercase to lowercase', () => {
    const upper = 'A'.repeat(64);
    const lower = 'a'.repeat(64);
    expect(sanitizeHashMemo(upper)).toBe(lower);
  });

  it('converts mixed case to lowercase', () => {
    const mixed = 'AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789';
    const expected = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    expect(sanitizeHashMemo(mixed)).toBe(expected);
  });

  it('trims whitespace', () => {
    const hash = ' ' + 'a'.repeat(64) + ' ';
    expect(sanitizeHashMemo(hash)).toBe('a'.repeat(64));
  });

  it('rejects hash that is too short', () => {
    expect(() => sanitizeHashMemo('a'.repeat(63))).toThrow('64');
  });

  it('rejects hash that is too long', () => {
    expect(() => sanitizeHashMemo('a'.repeat(65))).toThrow('64');
  });

  it('rejects non-hex characters', () => {
    expect(() => sanitizeHashMemo('g' + 'a'.repeat(63))).toThrow('hexadecimal');
  });
});

describe('sanitizeReturnMemo', () => {
  it('works identically to sanitizeHashMemo', () => {
    const hash = 'b'.repeat(64);
    expect(sanitizeReturnMemo(hash)).toBe(hash);
  });

  it('converts uppercase to lowercase', () => {
    const upper = 'B'.repeat(64);
    const lower = 'b'.repeat(64);
    expect(sanitizeReturnMemo(upper)).toBe(lower);
  });

  it('rejects invalid length', () => {
    expect(() => sanitizeReturnMemo('b'.repeat(63))).toThrow();
  });
});

describe('sanitizeMemo', () => {
  it('sanitizes plain string as TEXT memo', () => {
    const result = sanitizeMemo('hello');
    expect(result).toEqual({ type: 'text', value: 'hello' });
  });

  it('sanitizes typed TEXT memo', () => {
    const result = sanitizeMemo({ type: 'text', value: 'hello' });
    expect(result).toEqual({ type: 'text', value: 'hello' });
  });

  it('sanitizes typed ID memo', () => {
    const result = sanitizeMemo({ type: 'id', value: '42' });
    expect(result).toEqual({ type: 'id', value: '42' });
  });

  it('sanitizes typed HASH memo', () => {
    const hash = 'a'.repeat(64);
    const result = sanitizeMemo({ type: 'hash', value: hash.toUpperCase() });
    expect(result).toEqual({ type: 'hash', value: hash });
  });

  it('sanitizes typed RETURN memo', () => {
    const hash = 'b'.repeat(64);
    const result = sanitizeMemo({ type: 'return', value: hash.toUpperCase() });
    expect(result).toEqual({ type: 'return', value: hash });
  });

  it('rejects unknown memo type', () => {
    expect(() =>
      sanitizeMemo({ type: 'unknown' as never, value: 'test' }),
    ).toThrow('Unknown memo type');
  });

  it('rejects invalid memo value for type', () => {
    expect(() => sanitizeMemo({ type: 'text', value: '' })).toThrow();
    expect(() => sanitizeMemo({ type: 'id', value: '-1' })).toThrow();
    expect(() => sanitizeMemo({ type: 'hash', value: 'short' })).toThrow();
  });
});
