import { describe, expect, it, vi } from 'vitest';
import { ResponseInterceptor } from './response.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { REQUEST_ID_HEADER } from '../constants/headers';
import { Paginated } from '../interfaces/api-response.interface';

describe('ResponseInterceptor', () => {
  let interceptor: ResponseInterceptor<unknown>;

  beforeEach(() => {
    interceptor = new ResponseInterceptor();
  });

  const createMockContext = (requestId?: string): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: requestId ? { [REQUEST_ID_HEADER]: requestId } : {},
        }),
      }),
    } as unknown as ExecutionContext;
  };

  const createMockHandler = (returnValue: unknown): CallHandler => {
    return {
      handle: () => of(returnValue),
    } as unknown as CallHandler;
  };

  describe('intercept', () => {
    it('wraps successful responses in success envelope', (done) => {
      const context = createMockContext('test-request-id');
      const handler = createMockHandler({ data: 'test' });

      interceptor.intercept(context, handler).subscribe({
        next: (value) => {
          expect(value).toEqual({
            success: true,
            data: { data: 'test' },
            meta: {},
            requestId: 'test-request-id',
          });
          done();
        },
      });
    });

    it('handles null data', (done) => {
      const context = createMockContext();
      const handler = createMockHandler(null);

      interceptor.intercept(context, handler).subscribe({
        next: (value) => {
          expect(value).toEqual({
            success: true,
            data: null,
            meta: {},
            requestId: 'unknown',
          });
          done();
        },
      });
    });

    it('extracts items and meta from Paginated responses', (done) => {
      const paginated = new Paginated(
        [{ id: '1' }, { id: '2' }],
        { total: 2, page: 1, limit: 10 },
      );

      const context = createMockContext('test-request-id');
      const handler = createMockHandler(paginated);

      interceptor.intercept(context, handler).subscribe({
        next: (value) => {
          expect(value).toEqual({
            success: true,
            data: [{ id: '1' }, { id: '2' }],
            meta: { total: 2, page: 1, limit: 10 },
            requestId: 'test-request-id',
          });
          done();
        },
      });
    });

    it('uses unknown requestId when header is missing', (done) => {
      const context = createMockContext();
      const handler = createMockHandler({ data: 'test' });

      interceptor.intercept(context, handler).subscribe({
        next: (value) => {
          expect(value.requestId).toBe('unknown');
          done();
        },
      });
    });
  });
});
