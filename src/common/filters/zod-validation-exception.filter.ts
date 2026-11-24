import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { ErrorCode } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';
import { ZodValidationException } from '../pipes/zod-validation.pipe';
import {
  formatZodValidationErrors,
  ValidationErrorItem,
  ValidationIssueCode,
} from '../validators/zod-error';
import {
  resolvePrisma,
  resolveProblemRequestId,
  statusToErrorCode,
} from './problem-details.util';

/**
 * Standard client error response envelope.
 */
export interface StandardErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    errors?: ValidationErrorItem[];
  };
  meta: {
    requestId: string;
  };
}

interface ExpressErrorLike {
  status: number;
  type?: string;
  message?: string;
  expose?: boolean;
}

const EXPRESS_ERROR_DETAIL: Record<string, string> = {
  'entity.parse.failed': 'Malformed JSON in request body',
  'entity.too.large': 'Request body is too large',
  'encoding.unsupported': 'Unsupported request body encoding',
  'charset.unsupported': 'Unsupported request body charset',
};

function asExpressError(exception: unknown): ExpressErrorLike | undefined {
  if (typeof exception !== 'object' || exception === null) {
    return undefined;
  }
  const candidate = exception as Record<string, unknown>;
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

/**
 * Global exception filter that normalizes validation errors and all HTTP exceptions
 * into the canonical uniform envelope:
 * `{ success: false, error: { code, message, errors: [{ path, message, code }] }, meta: { requestId } }`.
 *
 * Guarantees:
 * - HTTP status remains 400 for validation failures.
 * - Missing body, malformed JSON, and query errors return structured field errors without unhandled exceptions.
 * - Field paths are dot-joined (e.g. `user.email`, `recipients.0.address`).
 * - Raw Zod codes are mapped to stable documented {@link ValidationIssueCode} codes.
 * - Internal server errors (500) never leak raw stack traces or internal schema details to the client.
 */
@Catch()
export class ZodValidationExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ZodValidationExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = resolveProblemRequestId(request);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ErrorCode.INTERNAL_ERROR;
    let message = 'An unexpected error occurred';
    let errors: ValidationErrorItem[] | undefined;

    if (exception instanceof ZodValidationException) {
      status = HttpStatus.BAD_REQUEST;
      code = exception.code;
      message = exception.message;
      errors = exception.errors;
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      code = ErrorCode.VALIDATION_ERROR;
      message = 'Request validation failed';
      errors = formatZodValidationErrors(exception);
    } else if (exception instanceof DomainException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      if (Array.isArray(exception.details)) {
        errors = exception.details as ValidationErrorItem[];
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      const body =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)
          : {};

      const rawMessage = typeof payload === 'string' ? payload : (body.message ?? exception.message);
      const isMalformedJson =
        status === HttpStatus.BAD_REQUEST &&
        typeof rawMessage === 'string' &&
        (/JSON/i.test(rawMessage) || /SyntaxError/i.test(exception.name));

      const isPayloadTooLarge =
        status === HttpStatus.PAYLOAD_TOO_LARGE ||
        (typeof rawMessage === 'string' && /too large/i.test(rawMessage));

      if (isMalformedJson) {
        message = 'Malformed JSON in request body';
        code = ErrorCode.VALIDATION_ERROR;
        errors = [
          {
            path: '',
            message,
            code: ValidationIssueCode.INVALID_VALUE,
          },
        ];
      } else if (isPayloadTooLarge) {
        message = 'Request body is too large';
        code = ErrorCode.VALIDATION_ERROR;
        errors = [
          {
            path: '',
            message,
            code: ValidationIssueCode.TOO_BIG,
          },
        ];
      } else if (Array.isArray(rawMessage)) {
        message = rawMessage.map(String).join(', ');
        errors = rawMessage.map((msg) => ({
          path: '',
          message: String(msg),
          code: ValidationIssueCode.INVALID_VALUE,
        }));
      } else {
        message = String(rawMessage);
      }

      if (typeof body.code === 'string') {
        code = body.code;
      } else if (!isMalformedJson && !isPayloadTooLarge) {
        const mappedCode = statusToErrorCode(status);
        code = mappedCode ?? (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST);
      }

      if (Array.isArray(body.errors)) {
        errors = body.errors as ValidationErrorItem[];
      } else if (status === HttpStatus.BAD_REQUEST && !errors) {
        errors = [
          {
            path: '',
            message,
            code: ValidationIssueCode.INVALID_VALUE,
          },
        ];
      }
    } else {
      const expressError = asExpressError(exception);
      if (expressError) {
        status = expressError.status;
        const mappedCode = statusToErrorCode(status);
        code = mappedCode ?? ErrorCode.VALIDATION_ERROR;

        const isMalformedJson =
          expressError.type === 'entity.parse.failed' ||
          exception instanceof SyntaxError ||
          (typeof expressError.message === 'string' && /JSON/i.test(expressError.message));

        const isPayloadTooLarge =
          expressError.type === 'entity.too.large' ||
          status === 413 ||
          (typeof expressError.message === 'string' && /too large/i.test(expressError.message));

        if (isMalformedJson) {
          message = 'Malformed JSON in request body';
        } else if (isPayloadTooLarge) {
          message = 'Request body is too large';
        } else if (expressError.type && EXPRESS_ERROR_DETAIL[expressError.type]) {
          message = EXPRESS_ERROR_DETAIL[expressError.type];
        } else if (expressError.expose && expressError.message) {
          message = expressError.message;
        } else {
          message = 'Request validation failed';
        }

        errors = [
          {
            path: '',
            message,
            code: isMalformedJson
              ? ValidationIssueCode.INVALID_VALUE
              : isPayloadTooLarge
                ? ValidationIssueCode.TOO_BIG
                : ValidationIssueCode.INVALID_VALUE,
          },
        ];
      } else {
        // Check for Prisma or other database errors without leaking raw SQL or schema
        try {
          const resolvedPrisma = resolvePrisma(exception);
          if (resolvedPrisma.code !== ErrorCode.INTERNAL_ERROR || resolvedPrisma.status !== 500) {
            status = resolvedPrisma.status;
            code = resolvedPrisma.code;
            message = resolvedPrisma.detail;
          }
        } catch {
          // Keep internal 500 fallback
        }
      }
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${status} ${code}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} -> ${status} ${code}: ${message}`,
      );
    }

    const envelope: StandardErrorEnvelope = {
      success: false,
      error: {
        code,
        message,
        ...(errors && errors.length > 0 ? { errors } : {}),
      },
      meta: {
        requestId,
      },
    };

    response.status(status).json(envelope);
  }
}

/**
 * Backwards compatibility / alias for ZodValidationExceptionFilter.
 */
export { ZodValidationExceptionFilter as ValidationExceptionFilter };
