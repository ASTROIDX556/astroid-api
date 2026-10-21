import { describe, expect, it } from 'vitest';
import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { stellarAssetCodeSchema } from '../../common/validators/stellar-asset.schema';
import { createTransactionSchema } from './transaction.dto';

const metadata: ArgumentMetadata = { type: 'body', metatype: Object };
const basePayload = {
  walletId: '550e8400-e29b-41d4-a716-446655440000',
  amount: '10.0000000',
  recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
};

describe('Stellar transaction payload validation', () => {
  it.each(['XLM', 'USDC', 'USD', 'A1', '123456789012'])(
    'accepts valid Stellar asset code %s',
    (asset) => {
      expect(stellarAssetCodeSchema.parse(asset)).toBe(asset);
    },
  );

  it.each([
    ['', 'Asset code is required'],
    ['ASSET-WITH-DASH', 'Asset code must contain only ASCII letters and digits'],
    ['ASSET_WITH_UNDERSCORE', 'Asset code must contain only ASCII letters and digits'],
    ['TOOLONGASSET123', 'Asset code must be at most 12 characters'],
    ['USD$', 'Asset code must contain only ASCII letters and digits'],
  ])('rejects invalid asset code %s with a useful validation message', (asset, message) => {
    const result = stellarAssetCodeSchema.safeParse(asset);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe(message);
  });

  it('rejects malformed G... public keys and invalid checksums', () => {
    const pipe = new ZodValidationPipe(createTransactionSchema);
    for (const recipientAddress of [
      'G-not-a-valid-key',
      'gdegsxlgankhk7qfov63xcbhbtz3yrkujv7zb7jmsjqb5cnbrll5qig5',
      'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG4',
      'CDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
    ]) {
      expect(() => pipe.transform({ ...basePayload, recipientAddress }, metadata)).toThrow(
        BadRequestException,
      );
    }
  });

  it('returns HTTP 400 with field-level details for invalid Stellar transfer payloads', () => {
    const pipe = new ZodValidationPipe(createTransactionSchema);
    try {
      pipe.transform({ ...basePayload, asset: 'USD$', amount: '-1' }, metadata);
      expect.fail('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const exception = error as BadRequestException;
      expect(exception.getStatus()).toBe(400);
      expect(exception.getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: expect.arrayContaining([
          expect.objectContaining({ path: 'asset' }),
          expect.objectContaining({ path: 'amount' }),
        ]),
      });
    }
  });

  it('rejects non-positive and over-precision amounts', () => {
    const pipe = new ZodValidationPipe(createTransactionSchema);
    for (const amount of ['0', '-0.01', '1.12345678', 'NaN', 'Infinity']) {
      expect(() => pipe.transform({ ...basePayload, amount }, metadata)).toThrow(
        BadRequestException,
      );
    }
  });

  it('parses a valid transfer and applies the default XLM asset', () => {
    const pipe = new ZodValidationPipe(createTransactionSchema);
    expect(pipe.transform(basePayload, metadata)).toMatchObject({
      asset: 'XLM',
      amount: '10.0000000',
      recipientAddress: basePayload.recipientAddress,
    });
  });
});
