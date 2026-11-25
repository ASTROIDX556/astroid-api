import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  signWebhookPayload,
  verifyWebhookSignature,
  parseWebhookSignatureHeader,
  formatWebhookSignatureHeader,
  verifyWebhookWithTolerance,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
} from './signing';

describe('Webhook signing utility', () => {
  const secret = 'whsec_test_secret_key_12345';
  const timestamp = '1700000000';
  const payload = Buffer.from(JSON.stringify({ event: 'transaction.completed', amount: 150 }));

  /** The canonical signed message: `${timestamp}.${rawBody}`. */
  function expectedDigest(secret: string, timestamp: string, body: Buffer): string {
    return createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), body])).digest('hex');
  }

  describe('signWebhookPayload & known test vectors', () => {
    it('produces the canonical header format t=<unix-seconds>,v1=<hex-hmac>', () => {
      const signature = signWebhookPayload(secret, timestamp, payload);
      expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    });

    it('verifies a signature against a fixed secret, timestamp and body', () => {
      const knownSecret = 'whsec_known_secret';
      const knownTimestamp = '1700000000';
      const knownPayload = Buffer.from('{"hello":"world"}');

      const signature = signWebhookPayload(knownSecret, knownTimestamp, knownPayload);
      const expected = `t=${knownTimestamp},v1=${expectedDigest(knownSecret, knownTimestamp, knownPayload)}`;

      expect(signature).toBe(expected);
      expect(verifyWebhookSignature(knownSecret, knownTimestamp, knownPayload, signature)).toBe(true);
    });

    it('produces a stable hex digest for fixed inputs', () => {
      const signature = signWebhookPayload(secret, timestamp, payload);
      const digest = createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`${timestamp}.`), payload]))
        .digest('hex');
      expect(signature).toBe(`t=${timestamp},v1=${digest}`);
      expect(verifyWebhookSignature(secret, timestamp, payload, signature)).toBe(true);
    });
  });

  describe('Header parsing & formatting', () => {
    it('parses composite t=...,v1=... signature header', () => {
      const parsed = parseWebhookSignatureHeader('t=1700000000,v1=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
      expect(parsed.timestamp).toBe('1700000000');
      expect(parsed.v1).toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    });

    it('handles extra whitespace in composite header', () => {
      const parsed = parseWebhookSignatureHeader('  t=1700000000 , v1=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  ');
      expect(parsed.timestamp).toBe('1700000000');
      expect(parsed.v1).toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    });

    it('formatWebhookSignatureHeader formats t=...,v1=... header correctly', () => {
      const formatted = formatWebhookSignatureHeader('1700000000', 'abcdef123456');
      expect(formatted).toBe('t=1700000000,v1=abcdef123456');
    });
  });

  describe('verifyWebhookSignature', () => {
    it('verifies a valid signature', () => {
      const signature = signWebhookPayload(secret, timestamp, payload);
      expect(verifyWebhookSignature(secret, timestamp, payload, signature)).toBe(true);
    });

    it('rejects altered payload (tampering detection)', () => {
      const signature = signWebhookPayload(secret, timestamp, payload);
      const tamperedPayload = Buffer.from(JSON.stringify({ event: 'transaction.completed', amount: 999999 }));
      expect(verifyWebhookSignature(secret, timestamp, tamperedPayload, signature)).toBe(false);
    });

    it('rejects altered timestamp (tampered header timestamp fails the HMAC)', () => {
      const signature = signWebhookPayload(secret, timestamp, payload);
      const tampered = signature.replace(`t=${timestamp}`, 't=1700000001');
      expect(tampered).not.toBe(signature);
      expect(verifyWebhookSignature(secret, timestamp, payload, tampered)).toBe(false);
    });

    it('rejects invalid secret', () => {
      const signature = signWebhookPayload(secret, timestamp, payload);
      expect(verifyWebhookSignature('whsec_different_secret', timestamp, payload, signature)).toBe(false);
    });

    it('rejects malformed signature length or characters', () => {
      expect(verifyWebhookSignature(secret, timestamp, payload, 'v1=not-hex')).toBe(false);
      expect(verifyWebhookSignature(secret, timestamp, payload, 'v1=1234')).toBe(false);
      expect(verifyWebhookSignature(secret, timestamp, payload, '')).toBe(false);
    });
  });

  describe('verifyWebhookWithTolerance (Replay Attack Protection)', () => {
    it('accepts valid delivery within 5-minute tolerance window', () => {
      const nowSeconds = 1700000100; // 100 seconds after timestamp
      const signature = signWebhookPayload(secret, timestamp, payload);

      const result = verifyWebhookWithTolerance(secret, timestamp, payload, signature, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, nowSeconds);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('rejects stale webhook older than tolerance window (replay attack)', () => {
      const nowSeconds = 1700000301; // 301 seconds after timestamp (tolerance: 300)
      const signature = signWebhookPayload(secret, timestamp, payload);

      const result = verifyWebhookWithTolerance(secret, timestamp, payload, signature, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, nowSeconds);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TIMESTAMP_EXPIRED');
    });

    it('rejects future timestamp exceeding tolerance window', () => {
      const nowSeconds = 1700000000 - 301; // 301 seconds in future
      const signature = signWebhookPayload(secret, timestamp, payload);

      const result = verifyWebhookWithTolerance(secret, timestamp, payload, signature, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, nowSeconds);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TIMESTAMP_EXPIRED');
    });

    it('detects payload tampering within tolerance window', () => {
      const nowSeconds = 1700000050;
      const signature = signWebhookPayload(secret, timestamp, payload);
      const tampered = Buffer.from('{"tampered":true}');

      const result = verifyWebhookWithTolerance(secret, timestamp, tampered, signature, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, nowSeconds);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('SIGNATURE_MISMATCH');
    });

    it('returns clear failure reasons for missing parameters', () => {
      expect(verifyWebhookWithTolerance('', timestamp, payload, 't=1700000000,v1=abc').reason).toBe('MISSING_SECRET');
      expect(verifyWebhookWithTolerance(secret, timestamp, payload, '').reason).toBe('MISSING_SIGNATURE');
      expect(verifyWebhookWithTolerance(secret, timestamp, undefined, 'v1=abc').reason).toBe('MISSING_PAYLOAD');
    });
  });
});
