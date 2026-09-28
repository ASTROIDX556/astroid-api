import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ArgumentsHost, BadRequestException, HttpException, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorCode } from '../constants/error-codes';
import { DomainException, ValidationException } from '../exceptions/domain.exception';
import { RequestContext } from '../context/request-context';

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
};

function buildHost(request: Record<string, unknown> = {}) {
  const response: MockResponse = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const req = {
    method: 'POST',
    url: '/api/v1/transactions',
    headers: {},
    ...request,
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => req }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

/** Reads the error envelope body captured by the mocked `response.json`. */
function renderedBody(response: MockResponse): {
  success: boolean;
  error: { code: string; message: string; details?: unknown };
  requestId: string;
} {
  expect(response.json).toHaveBeenCalledTimes(1);
  return response.json.mock.calls[0][0];
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('rate limiting (429)', () => {
    it('renders a ThrottlerException with the uniform error envelope', () => {
      const { host, response } = buildHost();

      filter.catch(new ThrottlerException('Rate limit exceeded'), host);

      expect(response.status).toHaveBeenCalledWith(429);
      expect(renderedBody(response)).toEqual({
        success: false,
        error: { code: ErrorCode.RATE_LIMITED, message: 'Rate limit exceeded' },
        requestId: expect.any(String),
      });
    });

    it('propagates the inbound request id so clients can correlate the rejection', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-42' } });

      filter.catch(new ThrottlerException(), host);

      expect(renderedBody(response).requestId).toBe('req-42');
    });

    it('uses the default throttler message when none is supplied', () => {
      const { host, response } = buildHost();

      filter.catch(new ThrottlerException(), host);

      expect(renderedBody(response).error.message).toBe('ThrottlerException: Too Many Requests');
    });
  });

  describe('other statuses', () => {
    it('maps a 404 HttpException onto NOT_FOUND', () => {
      const { host, response } = buildHost();

      filter.catch(new HttpException('Resource not found', 404), host);

      expect(response.status).toHaveBeenCalledWith(404);
      expect(renderedBody(response).error.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('joins an array of validation messages into a single string', () => {
      const { host, response } = buildHost();

      filter.catch(
        new BadRequestException(['email must be an email', 'age must be a number']),
        host,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      const body = renderedBody(response);
      expect(body.error.code).toBe(ErrorCode.BAD_REQUEST);
      expect(body.error.message).toBe('email must be an email, age must be a number');
    });

    it('falls back to INTERNAL_ERROR for unknown throwables', () => {
      const { host, response } = buildHost();

      filter.catch(new Error('boom'), host);

      expect(response.status).toHaveBeenCalledWith(500);
      expect(renderedBody(response)).toMatchObject({
        success: false,
        error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred' },
      });
    });

    it('renders non-Error throwables as INTERNAL_ERROR without crashing', () => {
      const { host, response } = buildHost();

      filter.catch('a string thrown somewhere', host);

      expect(response.status).toHaveBeenCalledWith(500);
      expect(renderedBody(response).error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });
  });

  describe('domain exceptions', () => {
    it('preserves the domain error code, status and details', () => {
      const { host, response } = buildHost();

      filter.catch(
        new ValidationException('Request validation failed', [
          { path: 'email', message: 'Invalid email' },
        ]),
        host,
      );

      expect(response.status).toHaveBeenCalledWith(422);
      expect(renderedBody(response)).toEqual({
        success: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Request validation failed',
          details: [{ path: 'email', message: 'Invalid email' }],
        },
        requestId: expect.any(String),
      });
    });

    it('renders a custom DomainException with its mapped HTTP status', () => {
      const { host, response } = buildHost();

      filter.catch(
        new DomainException(ErrorCode.WALLET_FROZEN, 'Wallet is frozen'),
        host,
      );

      expect(response.status).toHaveBeenCalledWith(423);
      expect(renderedBody(response).error.code).toBe(ErrorCode.WALLET_FROZEN);
    });
  });

  describe('Prisma database errors', () => {
    it('maps a P2002 unique-constraint violation onto 409 CONFLICT', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(409);
      expect(renderedBody(response)).toMatchObject({
        success: false,
        error: { code: ErrorCode.CONFLICT },
      });
    });

    it('maps a P2025 record-not-found error onto 404 NOT_FOUND', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(404);
      expect(renderedBody(response).error.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('maps other known Prisma request errors onto 400 BAD_REQUEST', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
        code: 'P2003',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(400);
      expect(renderedBody(response).error.code).toBe(ErrorCode.BAD_REQUEST);
    });
  });

  describe('request id tracking', () => {
    it('generates a fresh request id when the header is absent', () => {
      const { host, response } = buildHost();

      filter.catch(new Error('boom'), host);

      const { requestId } = renderedBody(response);
      expect(requestId).toMatch(/^req_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(requestId).not.toBe('unknown');
    });

    it('generates distinct request ids for separate error responses', () => {
      const first = buildHost();
      const second = buildHost();

      filter.catch(new Error('boom'), first.host);
      filter.catch(new Error('boom'), second.host);

      expect(renderedBody(first.response).requestId).not.toBe(
        renderedBody(second.response).requestId,
      );
    });

    it('recovers the request id from the ambient RequestContext when the header is missing', () => {
      const { host, response } = buildHost();

      RequestContext.run(
        {
          identity: {
            requestId: 'ctx-req-1',
            correlationId: 'ctx-req-1',
            traceId: 'ctx-req-1',
            method: 'POST',
            path: '/api/v1/transactions',
            url: '/api/v1/transactions',
            ip: null,
            userAgent: null,
            startedAt: Date.now(),
          },
          timings: {},
          data: {},
        },
        () => filter.catch(new Error('boom'), host),
      );

      expect(renderedBody(response).requestId).toBe('ctx-req-1');
    });

    it('prefers the inbound header over the ambient RequestContext', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'header-req-1' } });

      RequestContext.run(
        {
          identity: {
            requestId: 'ctx-req-1',
            correlationId: 'ctx-req-1',
            traceId: 'ctx-req-1',
            method: 'POST',
            path: '/api/v1/transactions',
            url: '/api/v1/transactions',
            ip: null,
            userAgent: null,
            startedAt: Date.now(),
          },
          timings: {},
          data: {},
        },
        () => filter.catch(new Error('boom'), host),
      );

      expect(renderedBody(response).requestId).toBe('header-req-1');
    });
  });
});
