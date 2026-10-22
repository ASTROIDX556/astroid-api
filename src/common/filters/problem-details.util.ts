import { HttpException, HttpStatus } from '@nestjs/common';
import { STATUS_CODES } from 'http';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { ERROR_TITLE, ErrorCode, problemTypeFor } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';
import { PROBLEM_JSON_CONTENT_TYPE, ProblemDetails } from '../interfaces/api-response.interface';
import { REQUEST_ID_HEADER } from '../constants/headers';
import { RequestContext } from '../context/request-context';

/** An exception reduced to the facts a problem details body is built from. */
export interface ResolvedError {
  status: number;
  code: ErrorCode;
  detail: string;
  details?: unknown;
  /**
   * True when the status has no dedicated error code (e.g. 405) and `code`
   * is only the generic fallback; the body then uses `about:blank` and the
   * HTTP reason phrase as RFC 9457 prescribes.
   */
  generic?: boolean;
}

/**
 * Errors raised outside the Nest request pipeline (body parsing, Express
 * middleware) carry an HTTP status but are not `HttpException`s.
 */
interface ExpressErrorLike {
  status: number;
  type?: string;
  message?: string;
  expose: boolean;
}

const ERROR_CODES = new Set<string>(Object.values(ErrorCode));

/**
 * Client-safe messages for the body-parser failures that can occur before a
 * request ever reaches Nest. The raw parser message is deliberately not used:
 * V8 includes a snippet of the offending body, which may hold secrets.
 */
const EXPRESS_ERROR_DETAIL: Record<string, string> = {
  'entity.parse.failed': 'Malformed JSON in request body',
  'entity.too.large': 'Request body is too large',
  'encoding.unsupported': 'Unsupported request body encoding',
  'charset.unsupported': 'Unsupported request body charset',
};

/**
 * Resolves the request id for an error response. The `x-request-id` header
 * (set by `RequestIdMiddleware`) is authoritative; when absent — e.g. an
 * error thrown before the middleware chain ran — the id is recovered from
 * the ambient {@link RequestContext} or freshly generated so every error
 * response still carries a correlatable identifier instead of `unknown`.
 */
export function resolveProblemRequestId(request: Pick<Request, 'headers'>): string {
  const headerId = request.headers?.[REQUEST_ID_HEADER] as string | undefined;
  if (headerId && headerId.length > 0) {
    return headerId;
  }
  return RequestContext.getRequestId() ?? `req_${uuidv7()}`;
}

/** Maps an HTTP status onto the matching machine-readable code, if any. */
export function statusToErrorCode(status: number): ErrorCode | undefined {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.BAD_REQUEST;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.RATE_LIMITED;
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return ErrorCode.VALIDATION_ERROR;
    case HttpStatus.INTERNAL_SERVER_ERROR:
      return ErrorCode.INTERNAL_ERROR;
    case HttpStatus.NOT_IMPLEMENTED:
      return ErrorCode.NOT_IMPLEMENTED;
    default:
      return undefined;
  }
}

/**
 * Reduces any thrown value to a {@link ResolvedError}. Supports domain
 * exceptions, Prisma known request errors, Nest `HttpException`s and the
 * Express-style errors (`err.status` / `err.statusCode`) that body parsing and
 * middleware raise before Nest's pipeline runs.
 */
export function resolveError(exception: unknown): ResolvedError {
  if (exception instanceof DomainException) {
    return {
      status: exception.getStatus(),
      code: exception.code,
      detail: exception.message,
      details: exception.details,
    };
  }

  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    return resolvePrisma(exception);
  }

  if (exception instanceof HttpException) {
    return resolveHttp(exception);
  }

  const expressError = asExpressError(exception);
  if (expressError) {
    return resolveExpress(expressError);
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: ErrorCode.INTERNAL_ERROR,
    detail: 'An unexpected error occurred',
  };
}

/**
 * Maps a Nest `HttpException`. A response object carrying a known `code`
 * (e.g. `ZodValidationException`'s `VALIDATION_ERROR`) keeps that code and
 * its `details`; otherwise the code is derived from the status. Arrays of
 * messages (class-validator) are joined into `detail` and kept as `details`.
 */
function resolveHttp(exception: HttpException): ResolvedError {
  const status = exception.getStatus();
  const payload = exception.getResponse();
  const body =
    typeof payload === 'object' && payload !== null
      ? (payload as { code?: unknown; message?: unknown; details?: unknown })
      : {};

  const rawMessage = typeof payload === 'string' ? payload : (body.message ?? exception.message);
  const messages = Array.isArray(rawMessage) ? rawMessage.map(String) : undefined;
  const detail = messages ? messages.join(', ') : String(rawMessage);

  if (typeof body.code === 'string' && ERROR_CODES.has(body.code)) {
    return {
      status,
      code: body.code as ErrorCode,
      detail,
      details: body.details ?? messages,
    };
  }

  const mapped = statusToErrorCode(status);
  return {
    status,
    code: mapped ?? (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST),
    detail,
    details: messages,
    generic: mapped === undefined,
  };
}

function resolvePrisma(exception: Prisma.PrismaClientKnownRequestError): ResolvedError {
  if (exception.code === 'P2025') {
    return {
      status: HttpStatus.NOT_FOUND,
      code: ErrorCode.NOT_FOUND,
      detail: 'Resource not found',
    };
  }
  if (exception.code === 'P2002') {
    return {
      status: HttpStatus.CONFLICT,
      code: ErrorCode.CONFLICT,
      detail: 'A resource with these unique attributes already exists',
    };
  }
  return {
    status: HttpStatus.BAD_REQUEST,
    code: ErrorCode.BAD_REQUEST,
    detail: 'Database request could not be processed',
  };
}

function asExpressError(exception: unknown): ExpressErrorLike | undefined {
  if (typeof exception !== 'object' || exception === null) {
    return undefined;
  }
  const candidate = exception as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
    message?: unknown;
    expose?: unknown;
  };
  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined;
  if (status === undefined || status < 400 || status > 599) {
    return undefined;
  }
  return {
    status,
    type: typeof candidate.type === 'string' ? candidate.type : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
    expose: candidate.expose === true,
  };
}

function resolveExpress(error: ExpressErrorLike): ResolvedError {
  const mapped = statusToErrorCode(error.status);
  const fallbackDetail =
    error.status >= 500
      ? 'An unexpected error occurred'
      : (STATUS_CODES[error.status] ?? 'Request could not be processed');
  const detail =
    (error.type ? EXPRESS_ERROR_DETAIL[error.type] : undefined) ??
    (error.status < 500 && error.expose && error.message ? error.message : fallbackDetail);

  return {
    status: error.status,
    code: mapped ?? (error.status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST),
    detail,
    generic: mapped === undefined,
  };
}

/** Builds the RFC 9457 body. Internal stacks are never serialized. */
export function buildProblemDetails(
  error: ResolvedError,
  request: Pick<Request, 'originalUrl' | 'url'>,
  requestId: string,
): ProblemDetails {
  const problem: ProblemDetails = {
    type: error.generic ? 'about:blank' : problemTypeFor(error.code),
    title: error.generic
      ? (STATUS_CODES[error.status] ?? ERROR_TITLE[error.code])
      : ERROR_TITLE[error.code],
    status: error.status,
    detail: error.detail,
    instance: requestPath(request),
    code: error.code,
    requestId,
    timestamp: new Date().toISOString(),
  };
  if (error.details !== undefined) {
    problem.details = error.details;
  }
  return problem;
}

/** The request path without its query string, which may carry secrets. */
export function requestPath(request: Pick<Request, 'originalUrl' | 'url'>): string {
  const url = request.originalUrl ?? request.url ?? '';
  return url.split('?')[0];
}

/** Writes a problem details body with the shared content type and status. */
export function sendProblemDetails(response: Response, problem: ProblemDetails): void {
  response.setHeader('Content-Type', PROBLEM_JSON_CONTENT_TYPE);
  response.status(problem.status).json(problem);
}
