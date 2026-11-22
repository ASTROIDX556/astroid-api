import { createHmac, timingSafeEqual } from 'crypto';

export const WEBHOOK_SIGNATURE_VERSION = 'v1';
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300; // 5 minutes

export interface ParsedWebhookSignature {
  timestamp?: string;
  v1?: string;
}

/**
 * Parses an explicit versioned signature header (e.g., `t=1700000000,v1=abcdef...` or `v1=abcdef...`).
 */
export function parseWebhookSignatureHeader(signatureHeader: string): ParsedWebhookSignature {
  if (!signatureHeader || typeof signatureHeader !== 'string') return {};
  const trimmed = signatureHeader.trim();
  if (trimmed.startsWith('v1=') && !trimmed.includes(',')) {
    return { v1: trimmed.slice(3) };
  }

  const result: ParsedWebhookSignature = {};
  const parts = trimmed.split(',');
  for (const part of parts) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (key === 't') {
      result.timestamp = value;
    } else if (key === 'v1') {
      result.v1 = value;
    }
  }
  return result;
}

/**
 * Formats a versioned signature header containing timestamp and hex digest.
 * e.g., `t=1700000000,v1=abcdef0123...`
 */
export function formatWebhookSignatureHeader(timestamp: string, v1Digest: string): string {
  const hex = v1Digest.startsWith('v1=') ? v1Digest.slice(3) : v1Digest;
  return `t=${timestamp},v1=${hex}`;
}

/**
 * Builds the canonical signed message: `${timestamp}.${rawBody}` — the
 * Stripe-style scheme the documented header `X-Astroid-Signature:
 * t=<unix-seconds>,v1=<hex-hmac>` is defined over.
 */
export function buildWebhookSignatureInput(timestamp: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), payload]);
}

/**
 * Signs the raw delivery bytes with the endpoint secret:
 * returns `t=<unix-seconds>,v1=<hex-hmac>`.
 */
export function signWebhookPayload(secret: string, timestamp: string, payload: Buffer): string {
  const digest = createHmac('sha256', secret)
    .update(buildWebhookSignatureInput(timestamp, payload))
    .digest('hex');
  return formatWebhookSignatureHeader(timestamp, digest);
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  payload: Buffer,
  signature: string,
): boolean {
  if (!secret || !payload || !signature) return false;
  const parsed = parseWebhookSignatureHeader(signature);
  const v1 = parsed.v1;
  const effectiveTimestamp = parsed.timestamp ?? timestamp;

  if (!/^\d{1,12}$/.test(effectiveTimestamp)) return false;
  if (!v1 || !/^[0-9a-fA-F]{64}$/.test(v1)) return false;

  const expected = Buffer.from(
    createHmac('sha256', secret).update(buildWebhookSignatureInput(effectiveTimestamp, payload)).digest('hex'),
    'hex',
  );
  const received = Buffer.from(v1, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface WebhookVerificationResult {
  valid: boolean;
  reason?:
    | 'MISSING_SECRET'
    | 'MISSING_SIGNATURE'
    | 'MISSING_PAYLOAD'
    | 'MALFORMED_TIMESTAMP'
    | 'MALFORMED_SIGNATURE'
    | 'TIMESTAMP_EXPIRED'
    | 'SIGNATURE_MISMATCH';
}

/**
 * Verifies an incoming webhook delivery with replay attack protection using a configurable tolerance window.
 *
 * @param secret The endpoint signing secret
 * @param timestamp The Unix timestamp in seconds (from the `t` field of the signature header)
 * @param payload The raw request body Buffer (unmodified, non-re-serialized)
 * @param signature The signature header (`t=<unix-seconds>,v1=<hex-hmac>`)
 * @param toleranceSeconds Replay attack window in seconds (default: 300 / 5 minutes)
 * @param nowSeconds Current Unix epoch in seconds (optional, for testing)
 */
export function verifyWebhookWithTolerance(
  secret: string,
  timestamp: string | undefined,
  payload: Buffer | undefined,
  signature: string | undefined,
  toleranceSeconds: number = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WebhookVerificationResult {
  if (!secret) return { valid: false, reason: 'MISSING_SECRET' };
  if (!signature) return { valid: false, reason: 'MISSING_SIGNATURE' };
  if (!payload || !Buffer.isBuffer(payload)) return { valid: false, reason: 'MISSING_PAYLOAD' };

  const parsed = parseWebhookSignatureHeader(signature);
  const effectiveTimestamp = parsed.timestamp ?? timestamp;

  if (!effectiveTimestamp || !/^\d{1,12}$/.test(effectiveTimestamp)) {
    return { valid: false, reason: 'MALFORMED_TIMESTAMP' };
  }

  const v1 = parsed.v1;
  if (!v1 || !/^[0-9a-fA-F]{64}$/.test(v1)) {
    return { valid: false, reason: 'MALFORMED_SIGNATURE' };
  }

  const timestampNum = Number(effectiveTimestamp);
  if (Math.abs(nowSeconds - timestampNum) > toleranceSeconds) {
    return { valid: false, reason: 'TIMESTAMP_EXPIRED' };
  }

  const isValid = verifyWebhookSignature(secret, effectiveTimestamp, payload, signature);
  if (!isValid) {
    return { valid: false, reason: 'SIGNATURE_MISMATCH' };
  }

  return { valid: true };
}
