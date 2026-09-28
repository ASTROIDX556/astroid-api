import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { ErrorCode } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';
import { ApiErrorResponse } from '../interfaces/api-response.interface';
import { REQUEST_ID_HEADER } from '../constants/headers';
import { RequestContext } from '../context/request-context';

/**
 * Global exception filter. Converts any thrown error into the canonical error
 * envelope `{ success:false, error:{ code, message }, requestId }`. Internal
 * details are never leaked to the client — they are logged with the requestId.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = this.resolveRequestId(request);

    const { status, body } = this.resolve(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${status} ${body.error.code}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} -> ${status} ${body.error.code}: ${body.error.message}`,
      );
    }

    response.status(status).json(body);
  }

  /**
   * Resolves the request id for an error response. The `x-request-id` header
   * (set by `RequestIdMiddleware`) is authoritative; when absent — e.g. an
   * error thrown before the middleware chain ran — the id is recovered from
   * the ambient {@link RequestContext} or freshly generated so every error
   * response still carries a correlatable identifier instead of `unknown`.
   */
  private resolveRequestId(request: Request): string {
    const headerId = request.headers[REQUEST_ID_HEADER] as string | undefined;
    if (headerId && headerId.length > 0) {
      return headerId;
    }
    return RequestContext.getRequestId() ?? `req_${uuidv7()}`;
  }

  private resolve(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ApiErrorResponse } {
    if (exception instanceof DomainException) {
      return {
        status: exception.getStatus(),
        body: {
          success: false,
          error: { code: exception.code, message: exception.message, details: exception.details },
          requestId,
        },
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.resolvePrisma(exception, requestId);
    }

    if (exception instanceof HttpException) {
      return this.resolveHttp(exception, requestId);
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        success: false,
        error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred' },
        requestId,
      },
    };
  }

  private resolveHttp(
    exception: HttpException,
    requestId: string,
  ): { status: number; body: ApiErrorResponse } {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const message =
      typeof payload === 'string'
        ? payload
        : ((payload as { message?: string | string[] }).message ?? exception.message);
    return {
      status,
      body: {
        success: false,
        error: {
          code: this.statusToCode(status),
          message: Array.isArray(message) ? message.join(', ') : message,
        },
        requestId,
      },
    };
  }

  private resolvePrisma(
    exception: Prisma.PrismaClientKnownRequestError,
    requestId: string,
  ): { status: number; body: ApiErrorResponse } {
    if (exception.code === 'P2025') {
      return this.errorBody(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Resource not found', requestId);
    }
    if (exception.code === 'P2002') {
      return this.errorBody(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        'A resource with these unique attributes already exists',
        requestId,
      );
    }
    return this.errorBody(
      HttpStatus.BAD_REQUEST,
      ErrorCode.BAD_REQUEST,
      'Database request could not be processed',
      requestId,
    );
  }

  private errorBody(
    status: number,
    code: ErrorCode,
    message: string,
    requestId: string,
  ): { status: number; body: ApiErrorResponse } {
    return { status, body: { success: false, error: { code, message }, requestId } };
  }

  private statusToCode(status: number): ErrorCode {
    switch (status) {
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
      default:
        return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST;
    }
  }
}
