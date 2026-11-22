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
  const eventId = 'evt-987654321';
  const payload = Buffer.from(JSON.stringify({ event: 'transaction.completed', amount: 150 }));

  describe('signWebhookPayload & known test vectors', () => {
    it('produces deterministic HMAC-SHA256 signature for fixed inputs', () => {
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);
      expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);

      const expectedDigest = createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`v1.${timestamp}.${eventId}.`), payload]))
        .digest('hex');

      expect(signature).toBe(`v1=${expectedDigest}`);
      expect(verifyWebhookSignature(secret, timestamp, eventId, payload, signature)).toBe(true);
    });

    it('produces known hex signature with known vector', () => {
      const knownSecret = 'whsec_known_secret';
      const knownTimestamp = '1700000000';
      const knownEventId = 'evt-test-vector';
      const knownPayload = Buffer.from('{"hello":"world"}');

      const expectedDigest = createHmac('sha256', knownSecret)
        .update(Buffer.concat([Buffer.from(`v1.${knownTimestamp}.${knownEventId}.`), knownPayload]))
        .digest('hex');

      const signature = signWebhookPayload(knownSecret, knownTimestamp, knownEventId, knownPayload);
      expect(signature).toBe(`v1=${expectedDigest}`);
    });
  });

  describe('Header parsing & formatting', () => {
    it('parses v1-only signature header', () => {
      const parsed = parseWebhookSignatureHeader('v1=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
      expect(parsed.v1).toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
      expect(parsed.timestamp).toBeUndefined();
    });

    it('parses composite t=...,v1=... signature header', () => {
      const header = 't=1700000000,v1=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      const parsed = parseWebhookSignatureHeader(header);
      expect(parsed.timestamp).toBe('1700000000');
      expect(parsed.v1).toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    });

    it('handles extra whitespace in composite header', () => {
      const header = '  t=1700000000 , v1=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  ';
      const parsed = parseWebhookSignatureHeader(header);
      expect(parsed.timestamp).toBe('1700000000');
      expect(parsed.v1).toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    });

    it('formatWebhookSignatureHeader formats t=...,v1=... header correctly', () => {
      const formatted = formatWebhookSignatureHeader('1700000000', 'v1=abcdef123456');
      expect(formatted).toBe('t=1700000000,v1=abcdef123456');
    });
  });

  describe('verifyWebhookSignature', () => {
    it('verifies signature formatted as v1=<hex>', () => {
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);
      expect(verifyWebhookSignature(secret, timestamp, eventId, payload, signature)).toBe(true);
    });

    it('verifies signature formatted as t=<timestamp>,v1=<hex>', () => {
      const digest = signWebhookPayload(secret, timestamp, eventId, payload).slice(3);
      const compositeSignature = `t=${timestamp},v1=${digest}`;
      expect(verifyWebhookSignature(secret, timestamp, eventId, payload, compositeSignature)).toBe(true);
    });

    it('rejects altered payload (tampering detection)', () => {
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);
      const tamperedPayload = Buffer.from(JSON.stringify({ event: 'transaction.completed', amount: 999999 }));
      expect(verifyWebhookSignature(secret, timestamp, eventId, tamperedPayload, signature)).toBe(false);
    });

    it('rejects altered timestamp', () => {
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);
      expect(verifyWebhookSignature(secret, '1700000001', eventId, payload, signature)).toBe(false);
    });

    it('rejects altered event ID', () => {
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);
      expect(verifyWebhookSignature(secret, timestamp, 'evt-tampered', payload, signature)).toBe(false);
    });

    it('rejects invalid secret', () => {
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);
      expect(verifyWebhookSignature('whsec_different_secret', timestamp, eventId, payload, signature)).toBe(false);
    });

    it('rejects malformed signature length or characters', () => {
      expect(verifyWebhookSignature(secret, timestamp, eventId, payload, 'v1=not-hex')).toBe(false);
      expect(verifyWebhookSignature(secret, timestamp, eventId, payload, 'v1=1234')).toBe(false);
    });
  });

  describe('verifyWebhookWithTolerance (Replay Attack Protection)', () => {
    it('accepts valid delivery within 5-minute tolerance window', () => {
      const nowSeconds = 1700000100; // 100 seconds after timestamp
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);

      const result = verifyWebhookWithTolerance(
        secret,
        timestamp,
        eventId,
        payload,
        signature,
        DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
        nowSeconds,
      );

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('rejects stale webhook older than tolerance window (replay attack)', () => {
      const nowSeconds = 1700000301; // 301 seconds after timestamp (tolerance: 300)
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);

      const result = verifyWebhookWithTolerance(
        secret,
        timestamp,
        eventId,
        payload,
        signature,
        DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
        nowSeconds,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TIMESTAMP_EXPIRED');
    });

    it('rejects future timestamp exceeding tolerance window', () => {
      const nowSeconds = 1700000000 - 301; // 301 seconds in future
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);

      const result = verifyWebhookWithTolerance(
        secret,
        timestamp,
        eventId,
        payload,
        signature,
        DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
        nowSeconds,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TIMESTAMP_EXPIRED');
    });

    it('detects payload tampering within tolerance window', () => {
      const nowSeconds = 1700000050;
      const signature = signWebhookPayload(secret, timestamp, eventId, payload);
      const tampered = Buffer.from('{"tampered":true}');

      const result = verifyWebhookWithTolerance(
        secret,
        timestamp,
        eventId,
        tampered,
        signature,
        DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
        nowSeconds,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('SIGNATURE_MISMATCH');
    });

    it('verifies composite t=...,v1=... signature with tolerance', () => {
      const nowSeconds = 1700000050;
      const digest = signWebhookPayload(secret, timestamp, eventId, payload).slice(3);
      const compositeSignature = `t=${timestamp},v1=${digest}`;

      const result = verifyWebhookWithTolerance(
        secret,
        undefined, // timestamp extracted directly from composite header
        eventId,
        payload,
        compositeSignature,
        DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
        nowSeconds,
      );

      expect(result.valid).toBe(true);
    });

    it('returns clear failure reasons for missing parameters', () => {
      expect(verifyWebhookWithTolerance('', timestamp, eventId, payload, 'v1=abc').reason).toBe('MISSING_SECRET');
      expect(verifyWebhookWithTolerance(secret, timestamp, eventId, payload, '').reason).toBe('MISSING_SIGNATURE');
      expect(verifyWebhookWithTolerance(secret, timestamp, '', payload, 'v1=abc').reason).toBe('MISSING_EVENT_ID');
      expect(verifyWebhookWithTolerance(secret, timestamp, eventId, undefined, 'v1=abc').reason).toBe('MISSING_PAYLOAD');
    });
  });
});
