import { describe, it, expect } from 'vitest';
import { StellarMemoPipe } from './stellar-memo.pipe';
import { ArgumentMetadata } from '@nestjs/common';
import { ValidationException } from '../exceptions/domain.exception';

describe('StellarMemoPipe', () => {
  const pipe = new StellarMemoPipe();
  const metadata: ArgumentMetadata = { type: 'body', metatype: Object };

  it('returns undefined for undefined input', () => {
    expect(pipe.transform(undefined, metadata)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(pipe.transform(null, metadata)).toBeUndefined();
  });

  it('transforms legacy string memo into typed format', () => {
    const result = pipe.transform('hello', metadata);
    expect(result).toEqual({ type: 'text', value: 'hello' });
  });

  it('transforms typed text memo', () => {
    const result = pipe.transform({ type: 'text', value: 'hello' }, metadata);
    expect(result).toEqual({ type: 'text', value: 'hello' });
  });

  it('transforms typed id memo', () => {
    const result = pipe.transform({ type: 'id', value: '42' }, metadata);
    expect(result).toEqual({ type: 'id', value: '42' });
  });

  it('transforms typed hash memo', () => {
    const hash = 'a'.repeat(64);
    const result = pipe.transform({ type: 'hash', value: hash }, metadata);
    expect(result).toEqual({ type: 'hash', value: hash });
  });

  it('transforms typed return memo', () => {
    const hash = 'b'.repeat(64);
    const result = pipe.transform({ type: 'return', value: hash }, metadata);
    expect(result).toEqual({ type: 'return', value: hash });
  });

  it('sanitizes uppercase hash to lowercase', () => {
    const upper = 'A'.repeat(64);
    const lower = 'a'.repeat(64);
    const result = pipe.transform({ type: 'hash', value: upper }, metadata);
    expect(result).toEqual({ type: 'hash', value: lower });
  });

  it('sanitizes ID memo by removing leading zeros', () => {
    const result = pipe.transform({ type: 'id', value: '007' }, metadata);
    expect(result).toEqual({ type: 'id', value: '7' });
  });

  it('trims whitespace from text memo', () => {
    const result = pipe.transform('  hello  ', metadata);
    expect(result).toEqual({ type: 'text', value: 'hello' });
  });

  it('throws on empty string memo', () => {
    try {
      pipe.transform('', metadata);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationException);
      const details = (e as ValidationException).details as Array<{ path: string; message: string }>;
      expect(details).toBeDefined();
      expect(details[0].message).toContain('cannot be empty');
    }
  });

  it('throws on text memo exceeding 28 bytes', () => {
    try {
      pipe.transform('a'.repeat(29), metadata);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationException);
      const details = (e as ValidationException).details as Array<{ path: string; message: string }>;
      expect(details).toBeDefined();
      expect(details[0].message).toContain('28 bytes');
    }
  });

  it('throws on invalid hash memo', () => {
    expect(() => pipe.transform({ type: 'hash', value: 'short' }, metadata)).toThrow();
  });

  it('throws on invalid ID memo', () => {
    expect(() => pipe.transform({ type: 'id', value: '-1' }, metadata)).toThrow();
  });

  it('throws on unknown memo type', () => {
    expect(() => pipe.transform({ type: 'unknown', value: 'test' }, metadata)).toThrow();
  });

  it('throws on object without type field', () => {
    expect(() => pipe.transform({ value: 'test' }, metadata)).toThrow();
  });

  it('throws on number input', () => {
    expect(() => pipe.transform(123, metadata)).toThrow();
  });

  it('throws on boolean input', () => {
    expect(() => pipe.transform(true, metadata)).toThrow();
  });
});
