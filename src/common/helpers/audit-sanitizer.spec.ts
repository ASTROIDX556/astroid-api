import { describe, expect, it } from 'vitest';
import { REDACTED, sanitizeAuditPayload, sanitizeLogArguments } from './audit-sanitizer';

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

  it('redacts authorization, cookies, API keys, webhook secrets, and passkey challenge material', () => {
    const input = {
      headers: { Authorization: 'Bearer fake.jwt.value', COOKIE: 'session=fake' },
      Api_Key: 'fake-api-key',
      webhookSigningSecret: 'fake-webhook-secret',
      passkeyChallenge: 'fake-challenge',
      stellarAddress: 'GABC123PUBLIC',
      requestId: 'req-safe-1',
      statusCode: 204,
    };

    expect(sanitizeAuditPayload(input)).toEqual({
      headers: { Authorization: REDACTED, COOKIE: REDACTED },
      Api_Key: REDACTED,
      webhookSigningSecret: REDACTED,
      passkeyChallenge: REDACTED,
      stellarAddress: 'GABC123PUBLIC',
      requestId: 'req-safe-1',
      statusCode: 204,
    });
    expect(input.headers.Authorization).toBe('Bearer fake.jwt.value');
  });

  it('sanitizes error messages, stack traces, and attached context', () => {
    const error = Object.assign(new Error('request failed with Bearer fake.token.value'), {
      context: { refreshToken: 'fake-refresh', requestId: 'req-safe-2' },
    });
    const sanitized = sanitizeAuditPayload(error) as unknown as Record<string, unknown>;

    expect(sanitized).toMatchObject({
      name: 'Error',
      message: 'request failed with Bearer [REDACTED]',
      context: { refreshToken: REDACTED, requestId: 'req-safe-2' },
    });
    expect(sanitized.stack).toContain('[REDACTED]');
  });

  it('redacts credential assignments embedded in free text', () => {
    expect(
      sanitizeAuditPayload('api_key=fake-api-key; ?signature=fake-signature; Cookie: session=fake-cookie'),
    ).toBe('api_key= [REDACTED]; ?signature= [REDACTED]; Cookie: [REDACTED]');
  });

  it('redacts both message strings and structured arguments at the logger boundary', () => {
    expect(
      sanitizeLogArguments(['request failed with token=fake-token', { requestId: 'req-1', apiKey: 'fake-key' }]),
    ).toEqual(['request failed with token= [REDACTED]', { requestId: 'req-1', apiKey: REDACTED }]);
  });

  it('handles cycles, depth, and oversized collections without mutating inputs', () => {
    const cyclic: Record<string, unknown> = { apiKey: 'fake-key' };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 12; index++) deep = { child: deep };
    const large = Array.from({ length: 510 }, (_, index) => index);

    const result = sanitizeAuditPayload({ cyclic, deep, large }) as Record<string, unknown>;
    expect(result.cyclic).toEqual({ apiKey: REDACTED, self: '[Circular]' });
    expect(JSON.stringify(result.deep)).toContain('[MaxDepth]');
    expect((result.large as unknown[])).toHaveLength(501);
    expect(cyclic.apiKey).toBe('fake-key');
    expect(large).toHaveLength(510);
  });
});
