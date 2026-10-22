import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { RequestTimeoutMiddleware } from './request-timeout.middleware';

describe('RequestTimeoutMiddleware (#315)', () => {
  it('completes normally when response finishes before timeout', () => {
    vi.useFakeTimers();
    const middleware = new RequestTimeoutMiddleware(100);
    const req = { originalUrl: '/api/v1/transactions' } as unknown as Request & {
      timedOut?: boolean;
    };
    const emitter = new EventEmitter();
    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();
    const res = Object.assign(emitter, {
      headersSent: false,
      status: statusMock,
      json: jsonMock,
    }) as unknown as Response;
    const next = vi.fn();

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    emitter.emit('finish');
    vi.advanceTimersByTime(200);
    expect(statusMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('returns 504 Gateway Timeout when request exceeds configured duration', () => {
    vi.useFakeTimers();
    const middleware = new RequestTimeoutMiddleware(50);
    const req = { originalUrl: '/api/v1/agents/slow' } as unknown as Request & {
      timedOut?: boolean;
    };
    const emitter = new EventEmitter();
    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();
    const res = Object.assign(emitter, {
      headersSent: false,
      status: statusMock,
      json: jsonMock,
    }) as unknown as Response;
    const next = vi.fn();

    middleware.use(req, res, next);
    vi.advanceTimersByTime(60);

    expect(req.timedOut).toBe(true);
    expect(statusMock).toHaveBeenCalledWith(504);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'GATEWAY_TIMEOUT' }),
      }),
    );
    vi.useRealTimers();
  });
});
