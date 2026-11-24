import { describe, expect, it } from 'vitest';
import { normalizeAccountOrContractAddress } from './address-normalizer.util';

describe('normalizeAccountOrContractAddress (#281)', () => {
  it('trims and uppercases valid G... and C... Stellar addresses', () => {
    const addr = `  g${'a'.repeat(55)}  `;
    expect(normalizeAccountOrContractAddress(addr)).toBe(`G${'A'.repeat(55)}`);
  });

  it('throws on malformed address strings', () => {
    expect(() => normalizeAccountOrContractAddress('invalid-addr')).toThrow(
      /Invalid Stellar/,
    );
  });
});
