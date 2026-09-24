import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodType, ZodError } from 'zod';
import { ValidationException } from '../exceptions/domain.exception';
import { formatZodError, ValidationErrorDetail } from '../validators/zod-error';

export interface ZodValidationPipeOptions {
  errorMap?: (error: ZodError) => ValidationErrorDetail[];
  customMessages?: Record<string, string>;
  locale?: string;
}

/**
 * A pipe that validates and parses an incoming payload against a Zod schema.
 * Instantiated per-schema, e.g. `@Body(new ZodValidationPipe(createAgentSchema))`.
 * Rejects unknown/invalid data with a structured VALIDATION_ERROR whose
 * `details` use the canonical {@link formatZodError} shape, supporting localized error message overrides.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly options?: ZodValidationPipeOptions,
  ) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      let details: ValidationErrorDetail[];
      if (this.options?.errorMap) {
        details = this.options.errorMap(result.error);
      } else if (this.options?.customMessages || this.options?.locale) {
        details = result.error.issues.map((issue) => {
          const path = issue.path.join('.');
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
          return { path, message };
        });
      } else {
        details = formatZodError(result.error);
      }
      throw new ValidationException('Request validation failed', details);
    }
    return result.data;
  }
}
