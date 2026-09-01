import { describe, expect, it } from 'vitest';
import { REDACTED, sanitizeAuditPayload } from './audit-sanitizer';

describe('sanitizeAuditPayload', () => {
  it('leaves non-object primitives untouched', () => {
    expect(sanitizeAuditPayload('hello')).toBe('hello');
    expect(sanitizeAuditPayload(42)).toBe(42);
    expect(sanitizeAuditPayload(null)).toBeNull();
    expect(sanitizeAuditPayload(undefined)).toBeUndefined();
  });

  it('redacts top-level sensitive field names', () => {
    const out = sanitizeAuditPayload({
      password: 'hunter2',
      secret: 's3cr3t',
      apiKey: 'sk-123',
      amount: 100,
    });

    expect(out).toEqual({
      password: REDACTED,
      secret: REDACTED,
      apiKey: REDACTED,
      amount: 100,
    });
  });

  it('is case-insensitive when matching sensitive field names', () => {
    const out = sanitizeAuditPayload({
      Password: 'x',
      API_KEY: 'y',
      privateKey: 'z',
      safe: 'ok',
    });

    expect(out).toEqual({
      Password: REDACTED,
      API_KEY: REDACTED,
      privateKey: REDACTED,
      safe: 'ok',
    });
  });

  it('redacts sensitive keys nested inside objects and arrays', () => {
    const out = sanitizeAuditPayload({
      memo: ['a', { webhookSecret: 'whsec_abc' }],
      nested: { credentials: { clientSecret: 'cs-1' }, amount: 10 },
    });

    expect(out).toEqual({
      memo: ['a', { webhookSecret: REDACTED }],
      nested: { credentials: REDACTED, amount: 10 },
    });
  });

  it('preserves the surrounding structure for non-sensitive data', () => {
    const input = { recipient: 'GABC', amount: '50 XLM', memo: 'invoice 42' };
    expect(sanitizeAuditPayload(input)).toEqual(input);
  });
});
