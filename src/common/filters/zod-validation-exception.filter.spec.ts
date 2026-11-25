import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ArgumentsHost,
  ForbiddenException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  StandardErrorEnvelope,
  ZodValidationExceptionFilter,
} from './zod-validation-exception.filter';
import { ErrorCode } from '../constants/error-codes';
import { PolicyViolationException } from '../exceptions/domain.exception';
import { ZodValidationException } from '../pipes/zod-validation.pipe';
import { ValidationIssueCode } from '../validators/zod-error';

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
    url: '/api/v1/test',
    originalUrl: '/api/v1/test',
    headers: {},
    ...request,
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => req }),
  } as unknown as ArgumentsHost;

  return { host, response };
}

function getResponseBody(response: MockResponse): StandardErrorEnvelope {
  expect(response.json).toHaveBeenCalledTimes(1);
  return response.json.mock.calls[0][0] as StandardErrorEnvelope;
}

describe('ZodValidationExceptionFilter (Unit)', () => {
  let filter: ZodValidationExceptionFilter;

  beforeEach(() => {
    filter = new ZodValidationExceptionFilter();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  describe('Zod validation errors', () => {
    it('formats a ZodValidationException with missing fields as REQUIRED', () => {
      const { host, response } = buildHost({ headers: { 'x-request-id': 'req_test_123' } });

      const schema = z.object({
        name: z.string(),
        email: z.string().email(),
      });
      const parseResult = schema.safeParse({});
      expect(parseResult.success).toBe(false);
      if (parseResult.success) return;

      const exception = new ZodValidationException(
        'Request validation failed',
        [],
        undefined,
        parseResult.error,
      );

      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      const body = getResponseBody(response);

      expect(body).toEqual({
        success: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Request validation failed',
          errors: [
            {
              path: 'name',
              message: 'Required',
              code: ValidationIssueCode.REQUIRED,
            },
            {
              path: 'email',
              message: 'Required',
              code: ValidationIssueCode.REQUIRED,
            },
          ],
        },
        meta: {
          requestId: 'req_test_123',
        },
      });
    });

    it('formats wrong types and out-of-range errors', () => {
      const { host, response } = buildHost();

      const schema = z.object({
        age: z.number().min(18).max(100),
        tag: z.string().min(3),
        status: z.enum(['active', 'inactive']),
      });
      const parseResult = schema.safeParse({
        age: 'not-a-number',
        tag: 'a',
        status: 'invalid-status',
      });
      expect(parseResult.success).toBe(false);
      if (parseResult.success) return;

      const exception = new ZodValidationException(
        'Request validation failed',
        [],
        undefined,
        parseResult.error,
      );

      filter.catch(exception, host);

      expect(response.status).toHaveBeenCalledWith(400);
      const body = getResponseBody(response);

      expect(body.success).toBe(false);
      expect(body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(body.error.errors).toContainEqual({
        path: 'age',
        message: 'Expected number, received string',
        code: ValidationIssueCode.INVALID_TYPE,
      });
      expect(body.error.errors).toContainEqual({
        path: 'tag',
        message: 'String must contain at least 3 character(s)',
        code: ValidationIssueCode.TOO_SMALL,
      });
      expect(body.error.errors).toContainEqual({
        path: 'status',
        message: "Invalid enum value. Expected 'active' | 'inactive', received 'invalid-status'",
        code: ValidationIssueCode.INVALID_ENUM,
      });
      expect(body.meta.requestId).toBeDefined();
    });

    it('formats nested object paths with dot notation and array index paths', () => {
      const { host, response } = buildHost();

      const schema = z.object({
        user: z.object({
          contacts: z.array(z.object({ phone: z.string().min(5) })),
        }),
      });
      const parseResult = schema.safeParse({
        user: {
          contacts: [{ phone: '12' }],
        },
      });
      expect(parseResult.success).toBe(false);
      if (parseResult.success) return;

      const exception = new ZodValidationException(
        'Request validation failed',
        [],
        undefined,
        parseResult.error,
      );

      filter.catch(exception, host);

      const body = getResponseBody(response);
      expect(body.error.errors).toEqual([
        {
          path: 'user.contacts.0.phone',
          message: 'String must contain at least 5 character(s)',
          code: ValidationIssueCode.TOO_SMALL,
        },
      ]);
    });

    it('formats raw ZodError when thrown directly', () => {
      const { host, response } = buildHost();

      const schema = z.object({ token: z.string().uuid() });
      const parseResult = schema.safeParse({ token: 'abc' });
      expect(parseResult.success).toBe(false);
      if (parseResult.success) return;

      filter.catch(parseResult.error, host);

      expect(response.status).toHaveBeenCalledWith(400);
      const body = getResponseBody(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(body.error.errors).toEqual([
        {
          path: 'token',
          message: 'Invalid uuid',
          code: ValidationIssueCode.INVALID_STRING,
        },
      ]);
    });
  });

  describe('Express and body-parser failures', () => {
    it('handles malformed JSON syntax error with status 400', () => {
      const { host, response } = buildHost();

      const syntaxError = Object.assign(new SyntaxError('Unexpected token in JSON at position 5'), {
        status: 400,
        type: 'entity.parse.failed',
      });

      filter.catch(syntaxError, host);

      expect(response.status).toHaveBeenCalledWith(400);
      const body = getResponseBody(response);
      expect(body.success).toBe(false);
      expect(body.error.message).toBe('Malformed JSON in request body');
      expect(body.error.errors).toEqual([
        {
          path: '',
          message: 'Malformed JSON in request body',
          code: ValidationIssueCode.INVALID_VALUE,
        },
      ]);
    });

    it('handles payload too large error with status 413', () => {
      const { host, response } = buildHost();

      const entityTooLarge = Object.assign(new Error('request entity too large'), {
        status: 413,
        type: 'entity.too.large',
      });

      filter.catch(entityTooLarge, host);

      expect(response.status).toHaveBeenCalledWith(413);
      const body = getResponseBody(response);
      expect(body.success).toBe(false);
      expect(body.error.message).toBe('Request body is too large');
    });
  });

  describe('Non-validation HTTP and Domain exceptions', () => {
    it('handles 401 UnauthorizedException', () => {
      const { host, response } = buildHost();

      filter.catch(new UnauthorizedException('Invalid or expired token'), host);

      expect(response.status).toHaveBeenCalledWith(401);
      const body = getResponseBody(response);
      expect(body).toEqual({
        success: false,
        error: {
          code: ErrorCode.UNAUTHORIZED,
          message: 'Invalid or expired token',
        },
        meta: {
          requestId: expect.any(String),
        },
      });
    });

    it('handles 403 ForbiddenException', () => {
      const { host, response } = buildHost();

      filter.catch(new ForbiddenException('Insufficient permissions'), host);

      expect(response.status).toHaveBeenCalledWith(403);
      const body = getResponseBody(response);
      expect(body.error.code).toBe(ErrorCode.FORBIDDEN);
      expect(body.error.message).toBe('Insufficient permissions');
    });

    it('handles 404 NotFoundException', () => {
      const { host, response } = buildHost();

      filter.catch(new NotFoundException('Agent not found'), host);

      expect(response.status).toHaveBeenCalledWith(404);
      const body = getResponseBody(response);
      expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
      expect(body.error.message).toBe('Agent not found');
    });

    it('handles PolicyViolationException (422 domain exception)', () => {
      const { host, response } = buildHost();

      filter.catch(new PolicyViolationException('Transfer exceeds policy limit'), host);

      expect(response.status).toHaveBeenCalledWith(422);
      const body = getResponseBody(response);
      expect(body.error.code).toBe(ErrorCode.POLICY_VIOLATION);
      expect(body.error.message).toBe('Transfer exceeds policy limit');
    });
  });

  describe('Unknown server faults (500)', () => {
    it('masks internal error details and stack traces', () => {
      const { host, response } = buildHost();

      const internalFault = new Error('SELECT * FROM users WHERE password_hash = ... failed');

      filter.catch(internalFault, host);

      expect(response.status).toHaveBeenCalledWith(500);
      const body = getResponseBody(response);
      expect(body).toEqual({
        success: false,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred',
        },
        meta: {
          requestId: expect.any(String),
        },
      });
      expect(JSON.stringify(body)).not.toContain('password_hash');
      expect(JSON.stringify(body)).not.toContain('SELECT');
      expect(JSON.stringify(body)).not.toContain('stack');
    });
  });
});
