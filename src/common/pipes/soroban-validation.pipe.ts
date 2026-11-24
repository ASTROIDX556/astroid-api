import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodType } from 'zod';
import { ZodValidationException } from './zod-validation.pipe';
import { formatZodError } from '../validators/zod-error';

/**
 * Specialized validation pipe for Soroban transaction parameters.
 * Extends the generic ZodValidationPipe with Soroban-specific error handling
 * and enhanced validation for Stellar contract interactions.
 *
 * This pipe provides clearer error messages for common Soroban validation failures:
 * - Invalid Stellar contract ID format
 * - Invalid function name format
 * - Invalid Stellar public key format
 * - Invalid XDR envelope format
 */
@Injectable()
export class SorobanValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const errorDetails = formatZodError(result.error);
      throw new ZodValidationException('Soroban transaction validation failed', errorDetails);
    }
    return result.data;
  }
}
