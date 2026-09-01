import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatZodError, ValidationErrorDetail } from './zod-error';

describe('formatZodError', () => {
  it('returns the canonical validation detail shape', () => {
    const schema = z.object({
      email: z.string().email(),
      age: z.number().min(18),
    });
    const result = schema.safeParse({ email: 'not-an-email', age: 12 });

    expect(result.success).toBe(false);
    if (result.success) return;

    const details = formatZodError(result.error);
    expect(details).toEqual([
      { path: 'email', message: 'Invalid email' },
      { path: 'age', message: 'Number must be greater than or equal to 18' },
    ]);
  });

  it('joins nested paths with dots', () => {
    const schema = z.object({
      profile: z.object({
        address: z.object({
          city: z.string().min(1),
        }),
      }),
    });
    const result = schema.safeParse({ profile: { address: { city: '' } } });

    expect(result.success).toBe(false);
    if (result.success) return;

    const details = formatZodError(result.error);
    expect(details[0]).toEqual({
      path: 'profile.address.city',
      message: 'String must contain at least 1 character(s)',
    });
  });

  it('formats numeric array indices in paths', () => {
    const schema = z.object({
      tags: z.array(z.string().min(3)),
    });
    const result = schema.safeParse({ tags: ['ok', 'no'] });

    expect(result.success).toBe(false);
    if (result.success) return;

    const details = formatZodError(result.error);
    expect(details).toContainEqual({
      path: 'tags.1',
      message: 'String must contain at least 3 character(s)',
    });
  });

  it('returns an empty array for an error with no issues', () => {
    const result = z.string().safeParse('ok');
    expect(result.success).toBe(true);
    if (result.success) return;
    expect(formatZodError(result.error)).toEqual([]);
  });

  it('emits details that satisfy the ValidationErrorDetail contract', () => {
    const result = z.object({ name: z.string().min(1) }).safeParse({ name: '' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const details: ValidationErrorDetail[] = formatZodError(result.error);
    expect(details[0].path).toBe('name');
    expect(typeof details[0].message).toBe('string');
  });
});
