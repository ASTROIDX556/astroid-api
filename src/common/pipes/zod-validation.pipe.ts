import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { ZodType, ZodError } from 'zod';
import { ErrorCode } from '../constants/error-codes';
import {
  formatZodDotPath,
  formatZodError,
  formatZodPath,
  formatZodValidationErrors,
  mapZodIssueCode,
  ValidationErrorDetail,
  ValidationErrorItem,
  ValidationIssueCode,
} from '../validators/zod-error';

export interface ZodValidationPipeOptions {
  errorMap?: (error: ZodError) => ValidationErrorDetail[];
  customMessages?: Record<string, string>;
  locale?: string;
}

/**
 * Thrown by {@link ZodValidationPipe} when a payload fails its Zod schema.
 *
 * Extends Nest's {@link BadRequestException} so the framework and global exception
 * filters treat it as a standard client-side HTTP error. Carries both structured
 * field problems:
 * - `errors`: uniform `{ path, message, code }` items with dot-joined paths and stable codes
 * - `details`: legacy `{ path, message, code }` details preserving original Zod codes
 */
export class ZodValidationException extends BadRequestException {
  /** Canonical domain error code preserved through the error envelope. */
  public readonly code = ErrorCode.VALIDATION_ERROR;

  /** Field-level validation problems in the legacy/ProblemDetails detail shape. */
  public readonly details: ValidationErrorDetail[];

  /** Structured validation problems with dot-joined paths and mapped issue codes. */
  public readonly errors: ValidationErrorItem[];

  /** Original ZodError instance if available. */
  public readonly zodError?: ZodError;

  constructor(
    message = 'Request validation failed',
    details: ValidationErrorDetail[] = [],
    errors?: ValidationErrorItem[],
    zodError?: ZodError,
  ) {
    const canonicalErrors =
      errors ??
      (zodError
        ? formatZodValidationErrors(zodError)
        : details.map((d) => ({
            path: d.path.replace(/\[(\d+)\]/g, '.$1'),
            message: d.message,
            code: mapZodIssueCode({ code: d.code, message: d.message }),
          })));

    super(
      {
        code: ErrorCode.VALIDATION_ERROR,
        message,
        details,
        errors: canonicalErrors,
      },
      message,
    );
    this.details = details;
    this.errors = canonicalErrors;
    this.zodError = zodError;
  }
}

/**
 * A pipe that validates and parses an incoming payload against a Zod schema.
 * Instantiated per-schema, e.g. `@Body(new ZodValidationPipe(createAgentSchema))`.
 * Rejects unknown/invalid data with a structured {@link ZodValidationException}.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly options?: ZodValidationPipeOptions,
  ) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    if (metadata.type === 'body' && (value === undefined || value === null)) {
      const issue: ValidationErrorItem = {
        path: '',
        message: 'Request body is required',
        code: ValidationIssueCode.REQUIRED,
      };
      throw new ZodValidationException(
        'Request validation failed',
        [{ path: '', code: 'invalid_type', message: 'Request body is required' }],
        [issue],
      );
    }

    const result = this.schema.safeParse(value);
    if (!result.success) {
      const details = this.formatDetails(result.error);
      const errors = this.formatErrors(result.error);
      throw new ZodValidationException(
        'Request validation failed',
        details,
        errors,
        result.error,
      );
    }
    return result.data;
  }

  /**
   * Converts a Zod parse failure into the canonical detail list, honouring
   * per-pipe overrides (custom error map, localized messages) when provided.
   */
  private formatDetails(error: ZodError): ValidationErrorDetail[] {
    if (this.options?.errorMap) {
      return this.options.errorMap(error);
    }

    const issues = error.issues.map((issue) => {
      const path = formatZodPath(issue.path);
      const code = issue.code;
      let message = issue.message;
      if (this.options?.customMessages) {
        if (path && this.options.customMessages[`${path}.${code}`]) {
          message = this.options.customMessages[`${path}.${code}`];
        } else if (path && this.options.customMessages[path]) {
          message = this.options.customMessages[path];
        } else if (this.options.customMessages[code]) {
          message = this.options.customMessages[code];
        }
      }
      return { path, code, message };
    });

    if (issues.length > 0) {
      return issues;
    }
    return formatZodError(error);
  }

  /**
   * Converts a Zod parse failure into the uniform `{ path, message, code }` items
   * with dot-joined paths and mapped stable issue codes.
   */
  private formatErrors(error: ZodError): ValidationErrorItem[] {
    return error.issues.map((issue) => {
      const dotPath = formatZodDotPath(issue.path);
      const legacyPath = formatZodPath(issue.path);
      const code = mapZodIssueCode(issue as { code: string; message?: string; received?: string });
      let message = issue.message;
      if (this.options?.customMessages) {
        if (dotPath && this.options.customMessages[`${dotPath}.${code}`]) {
          message = this.options.customMessages[`${dotPath}.${code}`];
        } else if (dotPath && this.options.customMessages[dotPath]) {
          message = this.options.customMessages[dotPath];
        } else if (legacyPath && this.options.customMessages[`${legacyPath}.${issue.code}`]) {
          message = this.options.customMessages[`${legacyPath}.${issue.code}`];
        } else if (legacyPath && this.options.customMessages[legacyPath]) {
          message = this.options.customMessages[legacyPath];
        } else if (this.options.customMessages[code]) {
          message = this.options.customMessages[code];
        } else if (this.options.customMessages[issue.code]) {
          message = this.options.customMessages[issue.code];
        }
      }
      return { path: dotPath, message, code };
    });
  }
}
