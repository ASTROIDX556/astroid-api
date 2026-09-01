import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodType } from 'zod';
import { ValidationException } from '../exceptions/domain.exception';
import { formatZodError } from '../validators/zod-error';

/**
 * A pipe that validates and parses an incoming payload against a Zod schema.
 * Instantiated per-schema, e.g. `@Body(new ZodValidationPipe(createAgentSchema))`.
 * Rejects unknown/invalid data with a structured VALIDATION_ERROR whose
 * `details` use the canonical {@link formatZodError} shape.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationException('Request validation failed', formatZodError(result.error));
    }
    return result.data;
  }
}
