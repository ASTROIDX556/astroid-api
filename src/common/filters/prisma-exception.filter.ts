import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ErrorCode } from '../constants/error-codes';
import {
  buildProblemDetails,
  resolveProblemRequestId,
  sendProblemDetails,
  ResolvedError,
} from './problem-details.util';

/**
 * Translates Prisma errors into stable HTTP status codes, machine-readable ErrorCodes,
 * and safe messages that never expose database internals, schema details, or raw SQL.
 */
export function resolvePrismaError(exception: unknown): ResolvedError {
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    if (exception.code === 'P2025') {
      return {
        status: HttpStatus.NOT_FOUND,
        code: ErrorCode.NOT_FOUND,
        detail: 'Resource not found',
      };
    }

    if (exception.code === 'P2002') {
      const target = exception.meta?.target;
      let field = '';
      if (Array.isArray(target) && target.length > 0) {
        field = target.join(', ');
      } else if (typeof target === 'string') {
        field = target;
      }

      const detail = field
        ? `A resource with this ${field} already exists`
        : 'A resource with these unique attributes already exists';

      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        detail,
      };
    }

    if (exception.code === 'P2003') {
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        detail:
          'Foreign key constraint failed: referenced resource does not exist or has dependent records',
      };
    }

    if (exception.code === 'P2000') {
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ErrorCode.VALIDATION_ERROR,
        detail: 'Provided value exceeds maximum allowed length for field',
      };
    }

    // All other known Prisma request codes return generic 500 without leaking SQL or internals
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      detail: 'An unexpected database error occurred',
    };
  }

  if (exception instanceof Prisma.PrismaClientValidationError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: ErrorCode.BAD_REQUEST,
      detail: 'Invalid database query or input data',
    };
  }

  // Unknown Prisma errors, initialization errors, or rust panic errors
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: ErrorCode.INTERNAL_ERROR,
    detail: 'An unexpected database error occurred',
  };
}

/**
 * Dedicated exception filter for Prisma database persistence failures.
 * Maps known error codes (P2002, P2025, P2003, P2000, validation errors)
 * to standard problem details response envelopes, preserving requestId and logging
 * internal details only server-side.
 */
@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientValidationError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientRustPanicError,
  Prisma.PrismaClientInitializationError,
)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = resolveProblemRequestId(request);

    const resolved = resolvePrismaError(exception);
    const body = buildProblemDetails(resolved, request, requestId);

    const prismaCode =
      exception instanceof Prisma.PrismaClientKnownRequestError ? exception.code : undefined;
    const prismaMeta =
      exception instanceof Prisma.PrismaClientKnownRequestError ? exception.meta : undefined;

    if (body.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${body.status} ${body.code}: Database error (code: ${prismaCode ?? 'UNKNOWN'}, meta: ${JSON.stringify(prismaMeta ?? {})})`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} -> ${body.status} ${body.code}: ${body.detail} (Prisma code: ${prismaCode ?? 'N/A'})`,
      );
    }

    sendProblemDetails(response, body);
  }
}
