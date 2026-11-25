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
      expect(body.detail).toBe('A resource with these details already exists');
      expect(body.requestId).toBe('req-uniq-1');
      expect(body.detail).not.toContain('Prisma');
      // The conflicting field names (meta.target) stay in the server log.
      expect(body.details).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('email');
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
      expect(body.detail).toBe('A resource with these details already exists');
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
    it('maps P2003 to 409 CONFLICT', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed on the field: `userId`', {
        code: 'P2003',
        clientVersion: '5.22.0',
      });

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(409);
      const body = renderedBody(response);
      expect(body.status).toBe(409);
      expect(body.code).toBe(ErrorCode.CONFLICT);
      expect(body.detail).toBe(
        'The operation conflicts with a related resource that does not exist or is still in use',
      );
      expect(JSON.stringify(body)).not.toContain('userId');
    });
  });

  describe('P2000 - Value too long', () => {
    it('maps P2000 to 400 BAD_REQUEST', () => {
      const { host, response } = buildHost();
      const error = new Prisma.PrismaClientKnownRequestError(
        "The provided value for the column is too long for the column's type.",
        {
          code: 'P2000',
          clientVersion: '5.22.0',
        },
      );

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(400);
      const body = renderedBody(response);
      expect(body.status).toBe(400);
      expect(body.code).toBe(ErrorCode.BAD_REQUEST);
      expect(body.detail).toBe('A provided value is too long');
    });
  });

  describe('P2023 - Inconsistent column data', () => {
    it('maps a malformed UUID to 400 BAD_REQUEST', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-uuid' } });
      const error = new Prisma.PrismaClientKnownRequestError(
        'Inconsistent column data: Error creating UUID, invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `z` at 1',
        { code: 'P2023', clientVersion: '5.22.0', meta: { modelName: 'Wallet', message: 'Error creating UUID' } },
      );

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(400);
      const body = renderedBody(response);
      expect(body).toMatchObject({
        status: 400,
        code: ErrorCode.BAD_REQUEST,
        detail: 'A provided value has an invalid format',
        requestId: 'req-uuid',
      });
      expect(JSON.stringify(body)).not.toMatch(/UUID|Wallet|urn:uuid/);
    });
  });

  describe('Connection and engine failures', () => {
    it.each([
      [
        'PrismaClientInitializationError',
        () => new Prisma.PrismaClientInitializationError("Can't reach database server at `db.internal:5432`", '5.22.0', 'P1001'),
      ],
      [
        'PrismaClientRustPanicError',
        () => new Prisma.PrismaClientRustPanicError('PANIC: called `Option::unwrap()` on a `None` value', '5.22.0'),
      ],
    ])('maps %s to 503 DATABASE_UNAVAILABLE', (_name, build) => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-db-down' } });

      filter.catch(build(), host);

      expect(response.status).toHaveBeenCalledWith(503);
      const body = renderedBody(response);
      expect(body).toMatchObject({
        status: 503,
        code: ErrorCode.DATABASE_UNAVAILABLE,
        title: 'Database Unavailable',
        detail: 'The database is temporarily unavailable; please retry later',
        requestId: 'req-db-down',
      });
      expect(JSON.stringify(body)).not.toMatch(/db\.internal|PANIC|unwrap/);
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

    it('logs the full original 4xx error (Prisma message, code, meta, stack) with the requestId, but returns only the safe message', () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-log-dup' } });
      const original = 'Unique constraint failed on the constraint: `users_email_key`';
      const error = new Prisma.PrismaClientKnownRequestError(original, {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: ['email'] },
      });

      filter.catch(error, host);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = String(warnSpy.mock.calls[0][0]);
      expect(logged).toContain('[req-log-dup]');
      expect(logged).toContain('-> 409 CONFLICT');
      expect(logged).toContain('PrismaClientKnownRequestError');
      expect(logged).toContain('Prisma code: P2002');
      expect(logged).toContain('"target":["email"]');
      expect(logged).toContain(original);
      expect(logged).toContain(error.stack!.split('\n')[1].trim());

      const body = JSON.stringify(renderedBody(response));
      expect(body).not.toContain('users_email_key');
      expect(body).not.toContain('email');
      expect(body).not.toContain('Unique constraint failed');
    });

    it('logs the full original 5xx error with its stack at error level with the requestId', () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req-log-down' } });
      const error = new Prisma.PrismaClientInitializationError(
        "Can't reach database server at `db.internal:5432`",
        '5.22.0',
        'P1001',
      );

      filter.catch(error, host);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, stack] = errorSpy.mock.calls[0] as [string, string];
      expect(message).toContain('[req-log-down]');
      expect(message).toContain('-> 503 DATABASE_UNAVAILABLE');
      expect(message).toContain('PrismaClientInitializationError');
      expect(message).toContain('code: P1001');
      expect(stack).toBe(error.stack);
      expect(stack).toContain('db.internal:5432');

      expect(JSON.stringify(renderedBody(response))).not.toContain('db.internal');
    });
  });
});
