import { describe, expect, it, vi } from 'vitest';
import { NextFunction, Request, Response } from 'express';
import {
  CorrelationIdMiddleware,
  sanitizeCorrelationId,
} from './correlation-id.middleware';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
} from '../constants/headers';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function run(headers: Record<string, string | undefined>) {
  const req = { headers: { ...headers } } as unknown as Request;
  const res = { setHeader: vi.fn() } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  new CorrelationIdMiddleware().use(req, res, next);

  return { req, res, next };
}

describe('CorrelationIdMiddleware', () => {
  it('preserves well-formed request and correlation ids', () => {
    const { req, res, next } = run({
      [REQUEST_ID_HEADER]: 'req-123',
      [CORRELATION_ID_HEADER]: 'corr-456',
    });

    expect(req.headers[REQUEST_ID_HEADER]).toBe('req-123');
    expect(req.headers[CORRELATION_ID_HEADER]).toBe('corr-456');
    expect(res.setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'req-123');
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'corr-456');
    expect(next).toHaveBeenCalledOnce();
  });

  it('generates a request id and reuses it as the correlation id when absent', () => {
    const { req, res } = run({});

    const requestId = req.headers[REQUEST_ID_HEADER] as string;
    expect(requestId).toMatch(UUID_PATTERN);
    expect(req.headers[CORRELATION_ID_HEADER]).toBe(requestId);
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, requestId);
  });

  it('replaces a malformed correlation id with a generated one', () => {
    const { req, res } = run({
      [REQUEST_ID_HEADER]: 'req-123',
      [CORRELATION_ID_HEADER]: 'bad id\nwith-control',
    });

    expect(req.headers[CORRELATION_ID_HEADER]).toBe('req-123');
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'req-123');
  });

  it('rejects control characters and oversized ids', () => {
    expect(sanitizeCorrelationId('abc\n123')).toBeUndefined();
    expect(sanitizeCorrelationId(`a${'b'.repeat(200)}`)).toBeUndefined();
    expect(sanitizeCorrelationId('')).toBeUndefined();
    expect(sanitizeCorrelationId('valid-id')).toBe('valid-id');
  });
});
