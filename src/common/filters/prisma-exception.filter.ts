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
 * Dedicated exception filter for Prisma database persistence failures. Maps
 * them through the shared mapper (P2002 → 409, P2025 → 404, P2003 → 409,
 * P2000 → 400, P2023 → 400, validation errors → 400, initialisation errors and
 * engine panics → 503, anything else → 500) to the standard problem details
 * envelope with the requestId.
 *
 * The client only ever receives the mapped code and a fixed, client-safe
 * message. The full original error — Prisma's message, error code, `meta` and
 * stack — is logged server-side with the requestId: 5xx at error level, 4xx at
 * warn level, the same levels as every other error.
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
    const errorClass = exception instanceof Error ? exception.constructor.name : typeof exception;
    // The stack's first line carries Prisma's original message, so this is the
    // full original error. It goes to the server log only, never to the client.
    const original = exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);

    if (body.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${body.status} ${body.code}: Database error (${errorClass}, code: ${prismaCode ?? 'UNKNOWN'}, meta: ${JSON.stringify(prismaMeta ?? {})})`,
        original,
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} -> ${body.status} ${body.code}: ${body.detail} (${errorClass}, Prisma code: ${prismaCode ?? 'N/A'}, meta: ${JSON.stringify(prismaMeta ?? {})})\n${original}`,
      );
    }

    sendProblemDetails(response, body);
  }
}
