import { describe, expect, it } from 'vitest';
import { WalletType, StellarNetwork } from '@prisma/client';

import {
  WALLET_LABEL_MAX_LENGTH,
  createWalletSchema,
  updateWalletSchema,
  walletLabelSchema,
} from './wallet.dto';
import { ZodValidationPipe, ZodValidationException } from '../../common/pipes/zod-validation.pipe';
import { ErrorCode } from '../../common/constants/error-codes';

/** A Stellar account address with a valid strkey checksum. */
const VALID_ADDRESS = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';
const VALID_UUID = '018f0a1b-7c3d-7a1e-9f2b-1c2d3e4f5a6b';

const metadata = { type: 'body' as const, metatype: Object };

/** Parses a payload through the pipe so the error envelope is exercised too. */
function parse(schema: typeof createWalletSchema | typeof updateWalletSchema, payload: unknown) {
  return new ZodValidationPipe(schema).transform(payload, metadata);
}

describe('walletLabelSchema', () => {
  it('accepts a normal label', () => {
    expect(walletLabelSchema.parse('Treasury')).toBe('Treasury');
  });

  it('trims and collapses the whitespace of a label', () => {
    expect(walletLabelSchema.parse('  Treasury   Ops  ')).toBe('Treasury Ops');
  });

  it('rejects an empty label', () => {
    expect(() => walletLabelSchema.parse('')).toThrow();
  });

  it('rejects a whitespace-only label', () => {
    expect(() => walletLabelSchema.parse('   ')).toThrow();
  });

  it('accepts a label at the maximum length', () => {
    const label = 'x'.repeat(WALLET_LABEL_MAX_LENGTH);
    expect(walletLabelSchema.parse(label)).toHaveLength(WALLET_LABEL_MAX_LENGTH);
  });

  it('rejects a label over the maximum length', () => {
    expect(() => walletLabelSchema.parse('x'.repeat(WALLET_LABEL_MAX_LENGTH + 1))).toThrow();
  });
});

describe('createWalletSchema', () => {
  it('applies the defaults of a generated wallet', () => {
    const parsed = createWalletSchema.parse({});

    expect(parsed).toEqual({
      walletType: WalletType.AGENT,
      network: StellarNetwork.TESTNET,
    });
  });

  it('accepts a fully specified generated wallet', () => {
    const parsed = createWalletSchema.parse({
      label: 'Operations',
      walletType: WalletType.TREASURY,
      network: StellarNetwork.PUBLIC,
      agentId: VALID_UUID,
    });

    expect(parsed).toEqual({
      label: 'Operations',
      walletType: WalletType.TREASURY,
      network: StellarNetwork.PUBLIC,
      agentId: VALID_UUID,
    });
  });

  it('accepts an imported wallet with a Stellar account address', () => {
    const parsed = createWalletSchema.parse({ stellarAddress: VALID_ADDRESS });

    expect(parsed.stellarAddress).toBe(VALID_ADDRESS);
  });

  it('rejects a Stellar contract id', () => {
    expect(() =>
      createWalletSchema.parse({
        stellarAddress: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      }),
    ).toThrow();
  });

  it('rejects a malformed Stellar address', () => {
    for (const address of [
      'not-an-address',
      'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG', // too short
      'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG6', // bad checksum
      'gdegsxlgankhk7qfov63xcbhbtz3yrkujv7zb7jmsjqb5cnbrll5qig5', // lower case
    ]) {
      expect(() => createWalletSchema.parse({ stellarAddress: address })).toThrow();
    }
  });

  it('rejects an unknown wallet type', () => {
    expect(() => createWalletSchema.parse({ walletType: 'COLD_STORAGE' })).toThrow();
  });

  it('rejects an unknown network', () => {
    expect(() => createWalletSchema.parse({ network: 'MAINNET' })).toThrow();
  });

  it('rejects a malformed agent id', () => {
    expect(() => createWalletSchema.parse({ agentId: 'agent-1' })).toThrow();
  });

  it('rejects an unexpected property', () => {
    expect(() => createWalletSchema.parse({ secretKey: 'SABC' })).toThrow();
  });

  it('rejects a wrong property type', () => {
    expect(() => createWalletSchema.parse({ label: 42 })).toThrow();
  });

  it('reports the failing field through the validation envelope', () => {
    try {
      parse(createWalletSchema, { stellarAddress: 'not-an-address' });
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodValidationException);
      const exception = error as ZodValidationException;
      expect(exception.getStatus()).toBe(400);
      expect(exception.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(exception.details.map((detail) => detail.path)).toContain('stellarAddress');
    }
  });
});

describe('updateWalletSchema', () => {
  it('accepts a label update', () => {
    expect(updateWalletSchema.parse({ label: 'Renamed' })).toEqual({ label: 'Renamed' });
  });

  it('accepts clearing the owning agent', () => {
    expect(updateWalletSchema.parse({ agentId: null })).toEqual({ agentId: null });
  });

  it('accepts reassigning the owning agent', () => {
    expect(updateWalletSchema.parse({ agentId: VALID_UUID })).toEqual({ agentId: VALID_UUID });
  });

  it('rejects an empty update body', () => {
    expect(() => updateWalletSchema.parse({})).toThrow();
  });

  it('rejects a malformed agent id', () => {
    expect(() => updateWalletSchema.parse({ agentId: 'agent-1' })).toThrow();
  });

  it('rejects an empty label', () => {
    expect(() => updateWalletSchema.parse({ label: '  ' })).toThrow();
  });

  it('rejects an unexpected property', () => {
    expect(() => updateWalletSchema.parse({ stellarAddress: VALID_ADDRESS })).toThrow();
  });

  it('reports the failing field through the validation envelope', () => {
    try {
      parse(updateWalletSchema, {});
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodValidationException);
      const exception = error as ZodValidationException;
      expect(exception.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(exception.details[0].message).toBe('Provide at least one field to update');
    }
  });
});
