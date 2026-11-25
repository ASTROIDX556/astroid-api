import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  computeRequestFingerprint,
  hashIdempotencyKey,
} from './request-fingerprint';

describe('request fingerprinting', () => {
  it('canonicalises objects independently of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('produces the same fingerprint for equivalent bodies', () => {
    expect(computeRequestFingerprint({ body: { amount: '50', asset: 'XLM' } })).toBe(
      computeRequestFingerprint({ body: { asset: 'XLM', amount: '50' } }),
    );
  });

  it('canonicalises nested objects independently of key order', () => {
    const left = { metadata: { b: [{ z: 1, y: 2 }], a: true }, amount: '50' };
    const right = { amount: '50', metadata: { a: true, b: [{ y: 2, z: 1 }] } };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(computeRequestFingerprint({ body: left })).toBe(
      computeRequestFingerprint({ body: right }),
    );
  });

  it('ignores JSON formatting whitespace but preserves whitespace inside values', () => {
    const compact = JSON.parse('{"amount":"50","memo":"hello world"}') as unknown;
    const spaced = JSON.parse('{ "memo" : "hello world", "amount" : "50" }') as unknown;

    expect(canonicalJson(compact)).toBe(canonicalJson(spaced));
    expect(
      computeRequestFingerprint({ body: { amount: '50', memo: 'hello  world' } }),
    ).not.toBe(computeRequestFingerprint({ body: { amount: '50', memo: 'hello world' } }));
  });

  it('produces a different fingerprint when the body differs', () => {
    expect(computeRequestFingerprint({ body: { amount: '50' } })).not.toBe(
      computeRequestFingerprint({ body: { amount: '51' } }),
    );
  });

  it('includes route parameters that scope the request', () => {
    expect(computeRequestFingerprint({ body: {}, params: { id: 'tx_1' } })).not.toBe(
      computeRequestFingerprint({ body: {}, params: { id: 'tx_2' } }),
    );
    expect(computeRequestFingerprint({ body: {}, params: {} })).toBe(
      computeRequestFingerprint({ body: {} }),
    );
  });

  it('hashes keys without ever returning the raw value', () => {
    const digest = hashIdempotencyKey('my-secret-key');
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain('my-secret-key');
  });
});
