import { describe, expect, it } from 'vitest';
import { TransferPayloadError, parseTransferPayload } from './transfer-payload';

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Canonicalises like the asset registry would. */
const canonicalize = (asset: string): string => asset.toUpperCase();

describe('parseTransferPayload', () => {
  it('parses a single-asset payload', () => {
    expect(parseTransferPayload({ asset: 'XLM', amount: '10.5' }, canonicalize)).toEqual([
      { asset: 'XLM', amount: 10.5 },
    ]);
  });

  it('parses a multi-asset payload', () => {
    const legs = parseTransferPayload(
      {
        transfers: [
          { asset: 'XLM', amount: '10' },
          { asset: 'USDC', amount: '25.25' },
        ],
      },
      canonicalize,
    );

    expect(legs).toEqual([
      { asset: 'XLM', amount: 10 },
      { asset: 'USDC', amount: 25.25 },
    ]);
  });

  it('keeps the recipient of a leg when the payload declares one', () => {
    const legs = parseTransferPayload(
      {
        transfers: [
          {
            asset: 'XLM',
            amount: '10',
            recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
          },
        ],
      },
      canonicalize,
    );

    expect(legs[0].recipientAddress).toBe(
      'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
    );
  });

  it('rejects the same asset twice in one payload', () => {
    expect(() =>
      parseTransferPayload(
        {
          transfers: [
            { asset: 'XLM', amount: '10' },
            { asset: 'xlm', amount: '5' },
          ],
        },
        canonicalize,
      ),
    ).toThrow(TransferPayloadError);
  });

  it('rejects a payload without an asset or a transfers array', () => {
    expect(() => parseTransferPayload({}, canonicalize)).toThrow(TransferPayloadError);
  });

  it('rejects a non-positive amount', () => {
    expect(() => parseTransferPayload({ asset: 'XLM', amount: '0' }, canonicalize)).toThrow(
      TransferPayloadError,
    );
    expect(() => parseTransferPayload({ asset: 'XLM', amount: -5 }, canonicalize)).toThrow(
      TransferPayloadError,
    );
  });

  it('rejects a non-finite amount', () => {
    expect(() => parseTransferPayload({ asset: 'XLM', amount: Number.NaN }, canonicalize)).toThrow(
      TransferPayloadError,
    );
  });

  it('rejects a non-numeric amount', () => {
    expect(() => parseTransferPayload({ asset: 'XLM', amount: 'abc' }, canonicalize)).toThrow(
      TransferPayloadError,
    );
    expect(() =>
      parseTransferPayload({ transfers: [{ asset: 'XLM', amount: 'abc' }] }, canonicalize),
    ).toThrow(TransferPayloadError);
  });

  it('rejects an infinite amount', () => {
    expect(() =>
      parseTransferPayload({ asset: 'XLM', amount: Number.POSITIVE_INFINITY }, canonicalize),
    ).toThrow(TransferPayloadError);
  });

  it('rejects a payload whose transfers array is empty', () => {
    expect(() => parseTransferPayload({ transfers: [] }, canonicalize)).toThrow(
      TransferPayloadError,
    );
  });

  it('accepts an issued asset identifier', () => {
    const legs = parseTransferPayload({ asset: `USDC:${ISSUER}`, amount: '3' }, canonicalize);
    expect(legs[0].asset).toBe(`USDC:${ISSUER}`);
  });
});
