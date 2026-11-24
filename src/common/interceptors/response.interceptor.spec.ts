import { describe, expect, it, beforeEach } from 'vitest';
import { ResponseInterceptor } from './response.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { REQUEST_ID_HEADER } from '../constants/headers';
import { Paginated } from '../interfaces/api-response.interface';
import { RequestContext } from '../context/request-context';
import { IDEMPOTENT_REPLAY, IDEMPOTENT_REPLAY_STATUS } from '../idempotency/idempotency.constants';

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
        getResponse: () => ({
          setHeader: () => undefined,
          status: () => undefined,
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

    it('extracts items and meta from Paginated responses', async () => {
      const paginated = new Paginated(
        [{ id: '1' }, { id: '2' }],
        { total: 2, page: 1, pageSize: 10, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
      );

      const context = createMockContext('test-request-id');
      const handler = createMockHandler(paginated);

      const result = await interceptor.intercept(context, handler).toPromise();
      expect(result).toBeDefined();
      if (!result) throw new Error('Result should be defined');
      expect(result).toEqual({
        success: true,
        data: [{ id: '1' }, { id: '2' }],
        meta: { total: 2, page: 1, pageSize: 10, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
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

    it('marks replayed responses with meta.idempotentReplay: true', async () => {
      await RequestContext.run(
        {
          identity: {
            requestId: 'req-duplicate',
            correlationId: 'corr-1',
            traceId: 'trace-1',
            method: 'POST',
            path: '/transactions',
            url: 'http://localhost/transactions',
            ip: null,
            userAgent: null,
            startedAt: Date.now(),
          },
          data: {
            [IDEMPOTENT_REPLAY]: true,
            [IDEMPOTENT_REPLAY_STATUS]: 201,
          },
          timings: {},
        } as Parameters<typeof RequestContext.run>[0],
        async () => {
          const context = createMockContext('req-duplicate');
          const handler = createMockHandler({ id: 'tx-1' });

          const result = await interceptor.intercept(context, handler).toPromise();
          if (!result) throw new Error('Result should be defined');
          expect(result.meta).toEqual({ idempotentReplay: true });
          expect(result.requestId).toBe('req-duplicate');
        },
      );
    });
  });
});
