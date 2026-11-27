import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import {
  buildProblemDetails,
  resolveError,
  resolveProblemRequestId,
  sendProblemDetails,
} from './problem-details.util';

/**
 * GlobalExceptionFilter — the platform-wide global exception filter for Astroid.
 *
 * Normalizes all thrown exceptions across all modules into the uniform, documented
 * problem details response envelope (`application/problem+json`):
 * `{ type, title, status, detail, instance, code, requestId, timestamp, details? }`.
 *
 * Behaviour summary:
 *  • Prisma client errors, via the shared `mapPrismaError` mapper
 *    (`src/common/exceptions/prisma-error.mapper.ts`)
 *      P2002 (unique constraint)  → 409 CONFLICT
 *      P2025 (record not found)   → 404 NOT_FOUND
 *      P2003 (foreign key)        → 409 CONFLICT
 *      P2000 (value too long)     → 400 BAD_REQUEST
 *      P2023 (bad column data)    → 400 BAD_REQUEST
 *      PrismaClientValidationError → 400 BAD_REQUEST
 *      initialisation / engine panic → 503 DATABASE_UNAVAILABLE
 *      other Prisma errors        → 500 INTERNAL_ERROR (no internals leaked)
 *  • `DomainException` subclasses → preserves `.code`, `.details`, status
 *  • `HttpException` (Nest built-ins, Throttler, ZodValidation, class-validator)
 *                                 → maps status → ErrorCode; preserves structured
 *                                   validation details array
 *  • Express / body-parser errors → client-safe messages (entity too large, invalid JSON)
 *  • Unknown throwables           → 500 INTERNAL_ERROR, no internals leaked
 *
 * Request IDs are preserved from the request context or `x-request-id` header.
 * Full stack traces are logged server-side with correlation request IDs and never
 * leaked to clients.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = resolveProblemRequestId(request);

    const resolved = resolveError(exception);
    const body = buildProblemDetails(resolved, request, requestId);

    if (body.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${body.status} ${body.code}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} -> ${body.status} ${body.code}: ${body.detail}`,
      );
    }

    sendProblemDetails(response, body);
  }
}
