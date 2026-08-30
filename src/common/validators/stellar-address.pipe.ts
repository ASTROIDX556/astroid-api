import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { ZodType } from 'zod';
import { stellarAddressSchema } from './stellar-address.schema';
import { ValidationException } from '../exceptions/domain.exception';

/**
 * NestJS validation pipe for a single Stellar address.
 *
 * Re-uses {@link stellarAddressSchema} (public keys + contract IDs) to reject
 * malformed addresses with the standard structured `VALIDATION_ERROR` envelope.
 * Pass a narrower schema to restrict to a specific strkey kind, e.g.
 * `new StellarAddressPipe(stellarEd25519PublicKeySchema)`.
 *
 * Usage:
 * ```
 * @Query(new StellarAddressPipe()) address: string
 * ```
 */
@Injectable()
export class StellarAddressPipe implements PipeTransform<unknown, string> {
  constructor(private readonly schema: ZodType<string> = stellarAddressSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): string {
    if (value === undefined || value === null || value === '') {
      throw new ValidationException('Stellar address is required');
    }

    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ValidationException('Invalid Stellar address', details);
    }
    return parsed.data;
  }
}