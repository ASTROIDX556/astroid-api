import { describe, it, expect } from 'vitest';
import { ArgumentMetadata } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';
import { ValidationException } from '../exceptions/domain.exception';

const metadata: ArgumentMetadata = { type: 'body', metatype: Object };

describe('ZodValidationPipe', () => {
  it('passes through valid input parsed by the schema', () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string() }));
    expect(pipe.transform({ name: 'alice' }, metadata)).toEqual({ name: 'alice' });
  });

  it('applies schema defaults and coercion', () => {
    const pipe = new ZodValidationPipe(
      z.object({ page: z.coerce.number().int().default(1) }),
    );
    expect(pipe.transform({}, metadata)).toEqual({ page: 1 });
  });

  it('throws a structured ValidationException on invalid input', () => {
    const pipe = new ZodValidationPipe(
      z.object({ email: z.string().email(), age: z.number().min(18) }),
    );
    try {
      pipe.transform({ email: 'not-an-email', age: 12 }, metadata);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationException);
      const details = (error as ValidationException).details as Array<{
        path: string;
        message: string;
      }>;
      expect(details).toEqual([
        { path: 'email', message: 'Invalid email' },
        { path: 'age', message: 'Number must be greater than or equal to 18' },
      ]);
    }
  });

  it('uses the canonical detail shape for nested paths', () => {
    const pipe = new ZodValidationPipe(
      z.object({
        profile: z.object({ address: z.object({ city: z.string().min(1) }) }),
      }),
    );
    try {
      pipe.transform({ profile: { address: { city: '' } } }, metadata);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationException);
      const details = (error as ValidationException).details as Array<{
        path: string;
        message: string;
      }>;
      expect(details[0].path).toBe('profile.address.city');
      expect(details[0].message).toContain('at least 1 character');
    }
  });

  it('emits VALIDATION_ERROR with status 422', () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string().min(1) }));
    try {
      pipe.transform({ name: '' }, metadata);
      expect.fail('Should have thrown');
    } catch (error) {
      const exception = error as ValidationException;
      expect(exception.code).toBe('VALIDATION_ERROR');
      expect(exception.getStatus()).toBe(422);
    }
  });
});
