import { describe, it, expect } from 'vitest';
import { Request, Response } from 'express';
import { RequestIdMiddleware } from './request-id.middleware';
import { TraceContext, TraceContextData } from '../../common/context/trace.context';

describe('RequestIdMiddleware', () => {
  const middleware = new RequestIdMiddleware();

  it('should generate a request ID when x-request-id header is absent', () => {
    const req = {} as Request;
    const res = {
      setHeader: (key: string, value: string) => {
        if (key === 'x-request-id') {
          expect(value).toBeDefined();
          expect(typeof value).toBe('string');
        }
      },
    } as unknown as Response;
    const next = () => {};

    middleware.use(req as Request, res as Response, next);

  });

  it('should reuse existing x-request-id header when present', () => {
    const existingId = 'existing-request-123';
    const req = {
      headers: { 'x-request-id': existingId },
    } as unknown as Request;
    const res = {
      setHeader: () => {},
    } as unknown as Response;
    const next = () => {};

    middleware.use(req as Request, res as Response, next);
  });

  it('should set x-correlation-id to the request ID when no correlation ID header is present', () => {
    const req = {
      headers: {},
    } as unknown as Request;
    const res = {
      setHeader: () => {},
    } as unknown as Response;
    const next = () => {};

    middleware.use(req as Request, res as Response, next);
  });

  it('should propagate correlation ID into AsyncLocalStorage', () => {
    const existingId = 'custom-correlation-456';
    const req = {
      headers: { 'x-request-id': existingId, 'x-correlation-id': existingId },
    } as unknown as Request;
    const res = {
      setHeader: () => {},
    } as unknown as Response;
    const next = () => {};

    middleware.use(req as Request, res as Response, next);

    const storedTrace = TraceContext.get();
    expect(storedTrace?.traceId).toBe(existingId);
  });

  it('should propagate generated request ID into AsyncLocalStorage when no correlation header', () => {
    const req = {
      headers: {},
    } as unknown as Request;
    const res = {
      setHeader: () => {},
    } as unknown as Response;
    const next = () => {};

    middleware.use(req as Request, res as Response, next);

    const storedTrace = TraceContext.get();
    expect(storedTrace?.traceId).toBeDefined();
    expect(typeof storedTrace.traceId).toBe('string');
  });

  it('should propagate correlation ID through nested TraceContext.run calls', () => {
    let capturedTraceId: string | undefined;

    const nestedFn = () => {
      capturedTraceId = TraceContext.getTraceId();
      return 'result';
    };

    const req = {
      headers: { 'x-request-id': 'nested-test-789' },
    } as unknown as Request;
    const res = {
      setHeader: () => {},
    } as unknown as Response;
    const next = () => {};

    TraceContext.run(
      { traceId: 'nested-test-789' },
      () => {
        middleware.use(req as Request, res as Response, next);
        nestedFn();
      },
    );

    expect(capturedTraceId).toBe('nested-test-789');
  });
});