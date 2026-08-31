import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { RawBodyMiddleware } from './raw-body.middleware';

interface MockRequest extends Pick<Request, 'method' | 'body'> {
  rawBody?: Buffer;
  on: ReturnType<typeof vi.fn>;
  _emit: (event: string, ...args: unknown[]) => void;
}

function buildRequest(method = 'POST', body?: unknown): MockRequest {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const req: MockRequest = {
    method,
    body,
    rawBody: undefined,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
      return { on: vi.fn() };
    }),
    _emit: (event: string, ...args: unknown[]) => listeners[event]?.(...args),
  };
  return req;
}

describe('RawBodyMiddleware', () => {
  it('skips non-POST/PUT/PATCH methods', () => {
    const middleware = new RawBodyMiddleware();
    const req = buildRequest('GET');
    const next = vi.fn();

    middleware.use(req as unknown as Request, {} as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.rawBody).toBeUndefined();
  });

  it('registers stream listeners to capture raw body for POST requests', () => {
    const middleware = new RawBodyMiddleware();
    const req = buildRequest('POST');
    const next = vi.fn();

    middleware.use(req as unknown as Request, {} as Response, next);
    expect(next).toHaveBeenCalled();

    // Verify 'data' and 'end' listeners were registered
    expect(req.on).toHaveBeenCalledWith('data', expect.any(Function));
    expect(req.on).toHaveBeenCalledWith('end', expect.any(Function));
  });

  it('re-serializes parsed body when rawBody is not set', () => {
    const middleware = new RawBodyMiddleware();
    const req = buildRequest('POST', { event: 'test' });
    const next = vi.fn();

    middleware.use(req as unknown as Request, {} as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.rawBody).toBeDefined();
    expect(req.rawBody!.toString()).toBe('{"event":"test"}');
  });

  it('handles string body', () => {
    const middleware = new RawBodyMiddleware();
    const req = buildRequest('POST', '{"event":"test"}');
    const next = vi.fn();

    middleware.use(req as unknown as Request, {} as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.rawBody).toBeDefined();
    expect(req.rawBody!.toString()).toBe('{"event":"test"}');
  });

  it('handles PUT method', () => {
    const middleware = new RawBodyMiddleware();
    const req = buildRequest('PUT', { update: true });
    const next = vi.fn();

    middleware.use(req as unknown as Request, {} as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.rawBody).toBeDefined();
  });

  it('handles PATCH method', () => {
    const middleware = new RawBodyMiddleware();
    const req = buildRequest('PATCH', { patch: true });
    const next = vi.fn();

    middleware.use(req as unknown as Request, {} as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.rawBody).toBeDefined();
  });
});
