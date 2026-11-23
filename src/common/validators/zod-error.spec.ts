import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  formatZodDotPath,
  formatZodError,
  formatZodValidationErrors,
  mapZodIssueCode,
  ValidationErrorDetail,
  ValidationErrorItem,
  ValidationIssueCode,
} from './zod-error';

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
      { path: 'email', code: 'invalid_string', message: 'Invalid email' },
      { path: 'age', code: 'too_small', message: 'Number must be greater than or equal to 18' },
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
      code: 'too_small',
      message: 'String must contain at least 1 character(s)',
    });
  });

  it('formats numeric array indices as brackets in paths', () => {
    const schema = z.object({
      tags: z.array(z.string().min(3)),
    });
    const result = schema.safeParse({ tags: ['ok', 'no'] });

    expect(result.success).toBe(false);
    if (result.success) return;

    const details = formatZodError(result.error);
    expect(details).toContainEqual({
      path: 'tags[1]',
      code: 'too_small',
      message: 'String must contain at least 3 character(s)',
    });
  });

  it('formats nested arrays and objects without throwing on unions or refinements', () => {
    const schema = z.object({
      budget: z.object({
        limits: z.array(z.object({ amount: z.number().positive() })),
      }),
      mode: z.union([z.literal('fast'), z.literal('safe')]),
    });
    const result = schema.safeParse({
      budget: { limits: [{ amount: 1 }, { amount: -2 }] },
      mode: 'other',
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const details = formatZodError(result.error);
    expect(details).toContainEqual({
      path: 'budget.limits[1].amount',
      code: 'too_small',
      message: 'Number must be greater than 0',
    });
    expect(details).toContainEqual({
      path: 'mode',
      code: 'invalid_union',
      message: 'Invalid input',
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
    expect(typeof details[0].code).toBe('string');
    expect(typeof details[0].message).toBe('string');
  });
});

describe('formatZodDotPath', () => {
  it('formats empty path as empty string', () => {
    expect(formatZodDotPath([])).toBe('');
  });

  it('formats simple field', () => {
    expect(formatZodDotPath(['email'])).toBe('email');
  });

  it('formats nested objects with dots', () => {
    expect(formatZodDotPath(['profile', 'address', 'city'])).toBe('profile.address.city');
  });

  it('formats array indices with dot-joined notation', () => {
    expect(formatZodDotPath(['recipients', 0, 'address'])).toBe('recipients.0.address');
    expect(formatZodDotPath(['items', 2])).toBe('items.2');
  });
});

describe('mapZodIssueCode', () => {
  it('maps missing required fields to REQUIRED', () => {
    expect(mapZodIssueCode({ code: 'invalid_type', received: 'undefined', message: 'Required' })).toBe(
      ValidationIssueCode.REQUIRED,
    );
    expect(mapZodIssueCode({ code: 'invalid_type', message: 'Field is required' })).toBe(
      ValidationIssueCode.REQUIRED,
    );
  });

  it('maps invalid type to INVALID_TYPE', () => {
    expect(mapZodIssueCode({ code: 'invalid_type', received: 'string', message: 'Expected number' })).toBe(
      ValidationIssueCode.INVALID_TYPE,
    );
  });

  it('maps too_small and too_big', () => {
    expect(mapZodIssueCode({ code: 'too_small' })).toBe(ValidationIssueCode.TOO_SMALL);
    expect(mapZodIssueCode({ code: 'too_big' })).toBe(ValidationIssueCode.TOO_BIG);
  });

  it('maps invalid_string, invalid_enum_value, invalid_date, invalid_literal', () => {
    expect(mapZodIssueCode({ code: 'invalid_string' })).toBe(ValidationIssueCode.INVALID_STRING);
    expect(mapZodIssueCode({ code: 'invalid_enum_value' })).toBe(ValidationIssueCode.INVALID_ENUM);
    expect(mapZodIssueCode({ code: 'invalid_date' })).toBe(ValidationIssueCode.INVALID_DATE);
    expect(mapZodIssueCode({ code: 'invalid_literal' })).toBe(ValidationIssueCode.INVALID_LITERAL);
  });

  it('maps unrecognized_keys and custom', () => {
    expect(mapZodIssueCode({ code: 'unrecognized_keys' })).toBe(ValidationIssueCode.UNRECOGNIZED_KEYS);
    expect(mapZodIssueCode({ code: 'custom' })).toBe(ValidationIssueCode.CUSTOM);
  });

  it('maps unknown codes to INVALID_VALUE', () => {
    expect(mapZodIssueCode({ code: 'not_multiple_of' })).toBe(ValidationIssueCode.INVALID_VALUE);
    expect(mapZodIssueCode({ code: 'unknown_future_code' })).toBe(ValidationIssueCode.INVALID_VALUE);
  });
});

describe('formatZodValidationErrors', () => {
  it('returns structured items with dot-joined paths and mapped codes', () => {
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().email(),
      age: z.number().min(18),
      items: z.array(z.object({ sku: z.string().min(3) })),
    });

    const result = schema.safeParse({
      name: '',
      email: 'not-email',
      age: 12,
      items: [{ sku: 'a' }],
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const items: ValidationErrorItem[] = formatZodValidationErrors(result.error);
    expect(items).toContainEqual({
      path: 'name',
      code: ValidationIssueCode.TOO_SMALL,
      message: 'String must contain at least 1 character(s)',
    });
    expect(items).toContainEqual({
      path: 'email',
      code: ValidationIssueCode.INVALID_STRING,
      message: 'Invalid email',
    });
    expect(items).toContainEqual({
      path: 'age',
      code: ValidationIssueCode.TOO_SMALL,
      message: 'Number must be greater than or equal to 18',
    });
    expect(items).toContainEqual({
      path: 'items.0.sku',
      code: ValidationIssueCode.TOO_SMALL,
      message: 'String must contain at least 3 character(s)',
    });
  });
});
