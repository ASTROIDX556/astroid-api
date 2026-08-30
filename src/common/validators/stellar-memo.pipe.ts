import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { stellarMemoSchema, StellarMemo } from './stellar-memo.schema';
import { sanitizeMemo } from './stellar-memo.sanitizer';
import { ValidationException } from '../exceptions/domain.exception';

/**
 * NestJS validation and sanitization pipe for Stellar transaction memos.
 *
 * Validates incoming memo data against the Stellar memo specification and
 * sanitizes/normalizes values before they reach the transaction processing layer.
 *
 * Supports all four Stellar memo types: TEXT, ID, HASH, and RETURN.
 *
 * Accepts either:
 * - A plain string (treated as TEXT memo), or
 * - An object with `type` and `value` fields for explicit memo type selection.
 *
 * Usage:
 * ```
 * @Body(new StellarMemoPipe()) memo?: StellarMemo
 * ```
 */
@Injectable()
export class StellarMemoPipe implements PipeTransform<unknown, StellarMemo | undefined> {
  transform(value: unknown, _metadata: ArgumentMetadata): StellarMemo | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    // Validate with Zod schema first
    const parseResult = stellarMemoSchema.safeParse(value);
    if (!parseResult.success) {
      const details = parseResult.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ValidationException('Invalid memo', details);
    }

    // Sanitize/normalize the validated value
    try {
      const sanitized = sanitizeMemo(parseResult.data);
      return sanitized;
    } catch (error) {
      if (error instanceof ValidationException) {
        throw error;
      }
      throw new ValidationException(
        'Memo sanitization failed',
        [(error as Error).message],
      );
    }
  }
}
