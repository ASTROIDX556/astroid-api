import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentsHost, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from './prisma-exception.filter';
import { ErrorCode } from '../constants/error-codes';
import { ProblemDetails } from '../interfaces/api-response.interface';

type MockResponse = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
};

function buildHost(request: Record<string, unknown> = {}) {
  const response: MockResponse = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  };
  const req = {
    method: 'POST',
    url: '/api/v1/developer/api-keys',
    originalUrl: '/api/v1/developer/api-keys',
    headers: {},
    ...request,
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => req }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

function renderedBody(response: MockResponse): ProblemDetails {
  expect(response.json).toHaveBeenCalledTimes(1);
  return response.json.mock.calls[0][0];
}

describe('PrismaExceptionFilter', () => {
  let filter: PrismaExceptionFilter;

  beforeEach(() => {
    filter = new PrismaExceptionFilter();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('P2002 - Unique constraint violation', () => {
    it('maps P2002 with targeted field to 409 CONFLICT and safe message', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-uniq-1' } });
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['email'] },
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(409);
      const body = renderedBody(response);
      expect(body.status).toBe(409);
      expect(body.code).toBe(ErrorCode.CONFLICT);
      expect(body.detail).toBe('A resource with this email already exists');
      expect(body.requestId).toBe('req-uniq-1');
      expect(body.detail).not.toContain('Prisma');
    });

    it('maps P2002 without target field to 409 CONFLICT with generic safe message', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(409);
      const body = renderedBody(response);
      expect(body.status).toBe(409);
      expect(body.code).toBe(ErrorCode.CONFLICT);
      expect(body.detail).toBe('A resource with these unique attributes already exists');
    });
  });

  describe('P2025 - Record not found', () => {
    it('maps P2025 to 404 NOT_FOUND', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-not-found' } });
      const error = new Prisma.PrismaClientKnownRequestError(
        'An operation failed because it depends on one or more records that were required but not found.',
        {
          code: 'P2025',
          clientVersion: '5.22.0',
        },
      );

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(404);
      const body = renderedBody(response);
      expect(body.status).toBe(404);
      expect(body.code).toBe(ErrorCode.NOT_FOUND);
      expect(body.detail).toBe('Resource not found');
      expect(body.requestId).toBe('req-not-found');
    });
  });

  describe('P2003 - Foreign key constraint', () => {
    it('maps P2003 to 400 BAD_REQUEST', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed on the field: `userId`', {
        code: 'P2003',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(400);
      const body = renderedBody(response);
      expect(body.status).toBe(400);
      expect(body.code).toBe(ErrorCode.BAD_REQUEST);
      expect(body.detail).toBe(
        'Foreign key constraint failed: referenced resource does not exist or has dependent records',
      );
    });
  });

  describe('P2000 - Value too long', () => {
    it('maps P2000 to 422 VALIDATION_ERROR', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError(
        "The provided value for the column is too long for the column's type.",
        {
          code: 'P2000',
          clientVersion: '5.22.0',
        },
      );

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(422);
      const body = renderedBody(response);
      expect(body.status).toBe(422);
      expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(body.detail).toBe('Provided value exceeds maximum allowed length for field');
    });
  });

  describe('PrismaClientValidationError', () => {
    it('maps query validation errors to 400 BAD_REQUEST', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientValidationError('Invalid `prisma.user.create()` invocation', {
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(400);
      const body = renderedBody(response);
      expect(body.status).toBe(400);
      expect(body.code).toBe(ErrorCode.BAD_REQUEST);
      expect(body.detail).toBe('Invalid database query or input data');
      expect(body.detail).not.toContain('prisma.user.create');
    });
  });

  describe('Unknown / unhandled Prisma errors', () => {
    it('maps unhandled error codes to 500 INTERNAL_ERROR without leaking SQL or internals', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError(
        'Raw query failed: SELECT secret_token FROM accounts WHERE id = 123',
        {
          code: 'P5000',
          clientVersion: '5.22.0',
        },
      );

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(500);
      const body = renderedBody(response);
      expect(body.status).toBe(500);
      expect(body.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(body.detail).toBe('An unexpected database error occurred');
      expect(body.detail).not.toContain('SELECT');
      expect(body.detail).not.toContain('secret_token');
    });

    it('maps PrismaClientUnknownRequestError to 500 INTERNAL_ERROR', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientUnknownRequestError('Unknown internal engine fault', {
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(500);
      const body = renderedBody(response);
      expect(body.status).toBe(500);
      expect(body.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(body.detail).toBe('An unexpected database error occurred');
    });
  });

  describe('Server-side logging and content type', () => {
    it('serves responses as application/problem+json', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/problem+json; charset=utf-8',
      );
    });

    it('logs 500 errors with error level and 4xx errors with warn level', () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const { host } = buildHost({ headers: { 'x-request-id': 'req-log-1' } });

      const p2025 = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.22.0',
      });
      filter.catch(p2025, host);
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();

      warnSpy.mockClear();
      const p9999 = new Prisma.PrismaClientKnownRequestError('Unknown crash', {
        code: 'P9999',
        clientVersion: '5.22.0',
      });
      filter.catch(p9999, host);
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
