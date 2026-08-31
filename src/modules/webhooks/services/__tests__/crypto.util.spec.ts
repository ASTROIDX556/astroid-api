import { describe, expect, it, vi } from 'vitest';
import { hmacSign } from '../crypto.util';

describe('crypto.util - hmacSign', () => {
  it('generates HMAC-SHA256 signature for a given secret and payload', () => {
    const secret = 'whsec_testsecret1234567890abcdef';
    const payload = '{"event":"transaction.created","data":{"id":"txn-1"}}';
    const signature = hmacSign(secret, payload);

    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(64); // SHA-256 hex digest is 64 characters
  });

  it('generates different signatures for different secrets', () => {
    const secret1 = 'whsec_secret1';
    const secret2 = 'whsec_secret2';
    const payload = '{"event":"test"}';

    const sig1 = hmacSign(secret1, payload);
    const sig2 = hmacSign(secret2, payload);

    expect(sig1).not.toBe(sig2);
  });

  it('generates different signatures for different payloads', () => {
    const secret = 'whsec_secret';
    const payload1 = '{"event":"test1"}';
    const payload2 = '{"event":"test2"}';

    const sig1 = hmacSign(secret, payload1);
    const sig2 = hmacSign(secret, payload2);

    expect(sig1).not.toBe(sig2);
  });

  it('generates consistent signature for same inputs', () => {
    const secret = 'whsec_consistent';
    const payload = '{"event":"consistent"}';

    const sig1 = hmacSign(secret, payload);
    const sig2 = hmacSign(secret, payload);

    expect(sig1).toBe(sig2);
  });
});