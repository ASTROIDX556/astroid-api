import { describe, expect, it } from 'vitest';
import {
  clamp,
  fromStroops,
  ONE_STROOP,
  parseAmount,
  STROOPS_PER_UNIT,
  toDecimalString,
  toStellarPrecision,
  toStroops,
} from './decimal.util';

describe('decimal.util', () => {
  describe('toStroops and fromStroops', () => {
    it('converts 1 whole XLM to 10,000,000 stroops', () => {
      expect(toStroops(1)).toBe(STROOPS_PER_UNIT);
      expect(fromStroops(STROOPS_PER_UNIT)).toBe(1);
    });

    it('converts 1 stroop (0.0000001) accurately', () => {
      expect(toStroops(ONE_STROOP)).toBe(1n);
      expect(fromStroops(1n)).toBe(0.0000001);
    });

    it('parses decimal string representations into stroops without float drift', () => {
      expect(toStroops('10.0000001')).toBe(100_000_001n);
      expect(toStroops('0.0000001')).toBe(1n);
      expect(toStroops('0')).toBe(0n);
      expect(toStroops('100')).toBe(1_000_000_000n);
    });

    it('avoids floating-point addition drift: 0.1 + 0.2 === 0.3', () => {
      const sum = toStroops(0.1) + toStroops(0.2);
      expect(sum).toBe(toStroops(0.3));
      expect(fromStroops(sum)).toBe(0.3);
    });

    it('throws on non-finite number or invalid string', () => {
      expect(() => toStroops(NaN)).toThrow('finite number');
      expect(() => toStroops(Infinity)).toThrow('finite number');
      expect(() => toStroops('')).toThrow('must not be empty');
      expect(() => toStroops('not-a-number')).toThrow('Invalid amount string');
    });

    it('handles negative amounts if passed', () => {
      expect(toStroops(-1)).toBe(-10_000_000n);
      expect(toStroops('-0.5')).toBe(-5_000_000n);
      expect(fromStroops(-10_000_000n)).toBe(-1);
    });
  });

  describe('parseAmount', () => {
    it('parses number or numeric string', () => {
      expect(parseAmount(42)).toBe(42);
      expect(parseAmount('42.5')).toBe(42.5);
    });

    it('throws on invalid number', () => {
      expect(() => parseAmount('invalid')).toThrow('Amount must be a finite number');
    });
  });

  describe('toStellarPrecision', () => {
    it('rounds to 7 decimal places', () => {
      expect(toStellarPrecision(1.123456789)).toBe(1.1234568);
    });
  });

  describe('clamp', () => {
    it('clamps values inside the bounds', () => {
      expect(clamp(5, 0, 10)).toBe(5);
      expect(clamp(-5, 0, 10)).toBe(0);
      expect(clamp(15, 0, 10)).toBe(10);
    });
  });

  describe('toDecimalString', () => {
    it('formats a number with fixed 7-decimal places', () => {
      expect(toDecimalString(10)).toBe('10.0000000');
      expect(toDecimalString(0.1234567)).toBe('0.1234567');
    });
  });
});
