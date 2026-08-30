import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { hmacSign, safeEqual, generateToken, sha256, generateApiKey } from './crypto.util';

describe('crypto.util', () => {
  describe('hmacSign', () => {
    it('produces a hex-encoded HMAC-SHA256 signature', () => {
      const secret = 'whsec_test-secret-key';
      const payload = '{"event":"transaction.completed","data":{}}';
      const signature = hmacSign(secret, payload);

      // Verify against manual HMAC-SHA256 computation
      const expected = createHmac('sha256', secret).update(payload).digest('hex');
      expect(signature).toBe(expected);
    });

    it('returns a 64-character hex string', () => {
      const signature = hmacSign('secret', 'payload');
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different signatures for different secrets', () => {
      const payload = '{"event":"test"}';
      const sig1 = hmacSign('secret-a', payload);
      const sig2 = hmacSign('secret-b', payload);
      expect(sig1).not.toBe(sig2);
    });

    it('produces different signatures for different payloads', () => {
      const secret = 'same-secret';
      const sig1 = hmacSign(secret, '{"a":1}');
      const sig2 = hmacSign(secret, '{"b":2}');
      expect(sig1).not.toBe(sig2);
    });

    it('produces deterministic signatures for the same inputs', () => {
      const sig1 = hmacSign('secret', 'payload');
      const sig2 = hmacSign('secret', 'payload');
      expect(sig1).toBe(sig2);
    });

    it('handles empty payload', () => {
      const signature = hmacSign('secret', '');
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it('handles Unicode payloads correctly', () => {
      const signature = hmacSign('secret', '{"name":"José 🔑"}');
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces a signature compatible with x-astroid-signature header format', () => {
      const secret = 'whsec_abc123';
      const body = JSON.stringify({ event: 'wallet.created', data: { id: 'w-1' } });
      const signature = hmacSign(secret, body);

      // The signature should be a valid hex string suitable for an HTTP header
      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(64);
      expect(Buffer.from(signature, 'hex').length).toBe(32);
    });
  });

  describe('safeEqual', () => {
    it('returns true for identical strings', () => {
      expect(safeEqual('abc', 'abc')).toBe(true);
    });

    it('returns true for identical hex signatures', () => {
      const sig = hmacSign('secret', 'payload');
      expect(safeEqual(sig, sig)).toBe(true);
    });

    it('returns false for different strings', () => {
      expect(safeEqual('abc', 'def')).toBe(false);
    });

    it('returns false for different-length strings', () => {
      expect(safeEqual('abc', 'abcd')).toBe(false);
    });

    it('returns false for completely different signatures', () => {
      const sig1 = hmacSign('secret-a', 'payload');
      const sig2 = hmacSign('secret-b', 'payload');
      expect(safeEqual(sig1, sig2)).toBe(false);
    });

    it('handles empty strings', () => {
      expect(safeEqual('', '')).toBe(true);
      expect(safeEqual('', 'a')).toBe(false);
    });
  });

  describe('generateToken', () => {
    it('generates a hex-encoded token of expected length', () => {
      const token = generateToken(32);
      // 32 bytes = 64 hex characters
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates different tokens on each call', () => {
      const token1 = generateToken(16);
      const token2 = generateToken(16);
      expect(token1).not.toBe(token2);
    });

    it('respects the byte length parameter', () => {
      const token8 = generateToken(8);
      const token16 = generateToken(16);
      expect(token8.length).toBe(16);
      expect(token16.length).toBe(32);
    });
  });

  describe('sha256', () => {
    it('returns a 64-character hex digest', () => {
      const hash = sha256('hello');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic', () => {
      expect(sha256('test')).toBe(sha256('test'));
    });

    it('produces different hashes for different inputs', () => {
      expect(sha256('a')).not.toBe(sha256('b'));
    });
  });

  describe('generateApiKey', () => {
    it('returns raw key with expected prefix format', () => {
      const key = generateApiKey('live');
      expect(key.raw).toMatch(/^ak_live_[0-9a-f]{48}$/);
      expect(key.prefix).toBe(key.raw.slice(0, 14));
    });

    it('includes SHA-256 hash of the raw key', () => {
      const key = generateApiKey();
      expect(key.hashedKey).toBe(sha256(key.raw));
    });

    it('uses the specified environment', () => {
      const testKey = generateApiKey('test');
      expect(testKey.raw).toMatch(/^ak_test_[0-9a-f]{48}$/);
    });

    it('generates unique keys on each call', () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1.raw).not.toBe(key2.raw);
    });
  });
});
