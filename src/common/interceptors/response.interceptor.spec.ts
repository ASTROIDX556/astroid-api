import { describe, expect, it, beforeEach } from 'vitest';
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

  const createMockContext = (requestId?: string, response?: { statusCode: number }): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: requestId ? { [REQUEST_ID_HEADER]: requestId } : {},
        }),
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
  };

  const createMockHandler = (returnValue: unknown): CallHandler => {
    return {
      handle: () => of(returnValue),
    } as unknown as CallHandler;
  };

  describe('intercept', () => {
    it('wraps successful responses in success envelope', async () => {
      const context = createMockContext('test-request-id');
      const handler = createMockHandler({ data: 'test' });

      const result = await interceptor.intercept(context, handler).toPromise();
      if (!result) throw new Error('Result should be defined');
      expect(result).toEqual({
        success: true,
        data: { data: 'test' },
        meta: {},
        requestId: 'test-request-id',
      });
    });

    it('handles null data', async () => {
      const context = createMockContext();
      const handler = createMockHandler(null);

      const result = await interceptor.intercept(context, handler).toPromise();
      if (!result) throw new Error('Result should be defined');
      expect(result).toEqual({
        success: true,
        data: null,
        meta: {},
        requestId: 'unknown',
      });
    });

    it('wraps arrays without changing their contents', async () => {
      const items = [{ id: '1' }, { id: '2' }];
      const result = await interceptor
        .intercept(createMockContext('array-request'), createMockHandler(items))
        .toPromise();

      expect(result).toEqual({
        success: true,
        data: items,
        meta: {},
        requestId: 'array-request',
      });
    });

    it('wraps primitive values as data', async () => {
      const result = await interceptor
        .intercept(createMockContext('primitive-request'), createMockHandler('accepted'))
        .toPromise();

      expect(result).toEqual({
        success: true,
        data: 'accepted',
        meta: {},
        requestId: 'primitive-request',
      });
    });

    it('preserves a custom HTTP status set by the controller', async () => {
      const response = { statusCode: 202 };
      const result = await interceptor
        .intercept(createMockContext('accepted-request', response), createMockHandler({ queued: true }))
        .toPromise();

      expect(response.statusCode).toBe(202);
      expect(result).toEqual({
        success: true,
        data: { queued: true },
        meta: {},
        requestId: 'accepted-request',
      });
    });

    it('extracts items and meta from Paginated responses', async () => {
      const paginated = new Paginated(
        [{ id: '1' }, { id: '2' }],
        { total: 2, page: 1, limit: 10, totalPages: 1, hasNext: false, hasPrev: false },
      );

      const context = createMockContext('test-request-id');
      const handler = createMockHandler(paginated);

      const result = await interceptor.intercept(context, handler).toPromise();
      expect(result).toBeDefined();
      if (!result) throw new Error('Result should be defined');
      expect(result).toEqual({
        success: true,
        data: [{ id: '1' }, { id: '2' }],
        meta: { total: 2, page: 1, limit: 10, totalPages: 1, hasNext: false, hasPrev: false },
        requestId: 'test-request-id',
      });
    });

    it('uses unknown requestId when header is missing', async () => {
      const context = createMockContext();
      const handler = createMockHandler({ data: 'test' });

      const result = await interceptor.intercept(context, handler).toPromise();
      if (!result) throw new Error('Result should be defined');
      expect(result.requestId).toBe('unknown');
    });
  });
});
