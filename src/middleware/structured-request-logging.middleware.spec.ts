import { EventEmitter } from 'events';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { StructuredRequestLoggingMiddleware } from './structured-request-logging.middleware';

/**
 * Pins the allow-list: the request log line carries exactly these fields and
 * nothing from the request body, so auth, API-key and webhook-secret endpoints
 * can never leak credentials through it.
 */
describe('StructuredRequestLoggingMiddleware', () => {
  function run(path: string, body: Record<string, unknown>) {
    const info = vi.fn();
    const req = {
      id: 'req-1',
      method: 'POST',
      path,
      headers: { authorization: 'Bearer abc', 'x-api-key': 'ak_live_secret' },
      body,
      log: { info },
    } as unknown as Request;
    const res = Object.assign(new EventEmitter(), { statusCode: 201 }) as unknown as Response;
    const next: NextFunction = vi.fn();

    new StructuredRequestLoggingMiddleware().use(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    return info;
  }

  it.each([
    ['/api/v1/auth/login', { email: 'a@b.c', password: 'hunter2' }],
    ['/api/v1/auth/refresh', { refreshToken: 'eyJ.refresh.token' }],
    ['/api/v1/developer/api-keys', { name: 'ci', key: 'ak_live_plaintext' }],
    ['/api/v1/webhooks', { url: 'https://x.test', signingSecret: 'whsec_abc' }],
  ])('logs only the allow-listed fields for %s', (path, body) => {
    const info = run(path, body);

    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(Object.keys(fields).sort()).toEqual(
      ['durationMs', 'method', 'path', 'requestId', 'statusCode'].sort(),
    );
    expect(message).toBe('HTTP request completed');
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/hunter2|refresh\.token|plaintext|whsec_|Bearer/);
  });
});
