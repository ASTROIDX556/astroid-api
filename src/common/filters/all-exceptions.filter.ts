import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import {
  buildProblemDetails,
  resolveError,
  resolveProblemRequestId,
  sendProblemDetails,
} from './problem-details.util';

/**
 * Global exception filter. Converts any thrown error into an RFC 9457 problem
 * details body (`application/problem+json`):
 * `{ type, title, status, detail, instance, code, requestId, timestamp, details? }`.
 *
 * Error classification and serialization live in `problem-details.util.ts`,
 * which is the single source of truth for the schema. Nest forwards errors
 * raised outside its request pipeline (body-parser rejections, middleware
 * `next(err)` calls) to this same filter, so those are covered too — including
 * the Express-style `err.status` / `err.statusCode` shape they arrive in.
 *
 * Internal details are never leaked to the client; unexpected errors are logged
 * with the requestId (and their stack only in the server log) and returned as a
 * generic 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

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
