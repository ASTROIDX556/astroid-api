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
