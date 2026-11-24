import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { mapPrismaError } from '../exceptions/prisma-error.mapper';
import {
  buildProblemDetails,
  resolvePrisma,
  resolveProblemRequestId,
  sendProblemDetails,
  ResolvedError,
} from './problem-details.util';

/**
 * Translates Prisma errors into stable HTTP status codes, machine-readable
 * ErrorCodes and safe messages that never expose database internals, schema
 * details or raw SQL. Kept as an alias of {@link resolvePrisma}; both delegate
 * to the shared `mapPrismaError` mapper.
 */
export function resolvePrismaError(exception: unknown): ResolvedError {
  return resolvePrisma(exception);
}

/**
 * Dedicated exception filter for Prisma database persistence failures.
 * Maps known error codes (P2002 → 409, P2025 → 404, P2003 → 400, P2000 → 422,
 * validation errors → 400)
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

    const prismaCode = mapPrismaError(exception)?.prismaCode;
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
