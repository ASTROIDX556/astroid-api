import { ZodError } from 'zod';

/**
 * Stable, documented validation issue codes. Raw Zod internals are mapped to
 * this enum so client applications can reliably switch on error reasons.
 */
export enum ValidationIssueCode {
  /** A required property was missing, null or undefined. */
  REQUIRED = 'REQUIRED',
  /** The value provided did not match the expected primitive or object type. */
  INVALID_TYPE = 'INVALID_TYPE',
  /** The value is below the minimum allowed (e.g. string length, number, array length). */
  TOO_SMALL = 'TOO_SMALL',
  /** The value exceeds the maximum allowed (e.g. string length, number, array length). */
  TOO_BIG = 'TOO_BIG',
  /** The string does not match the expected format (e.g. email, uuid, url, regex). */
  INVALID_STRING = 'INVALID_STRING',
  /** The value is not a member of the allowed enum set. */
  INVALID_ENUM = 'INVALID_ENUM',
  /** The value cannot be parsed as a valid ISO or date representation. */
  INVALID_DATE = 'INVALID_DATE',
  /** The value does not match the expected literal. */
  INVALID_LITERAL = 'INVALID_LITERAL',
  /** The object contains unknown or disallowed properties in a strict schema. */
  UNRECOGNIZED_KEYS = 'UNRECOGNIZED_KEYS',
  /** A custom validator or refinement failed. */
  CUSTOM = 'CUSTOM',
  /** Generic fallback for values that violate domain validation rules. */
  INVALID_VALUE = 'INVALID_VALUE',
}

/**
 * Standard structured validation error issue returned inside the API error envelope:
 * `{ path, message, code }`.
 */
export interface ValidationErrorItem {
  /**
   * Dot-joined property path identifying the failing field, e.g. `email`,
   * `profile.address.city`, or `recipients.0.address`. Empty string for root failures.
   */
  path: string;
  /** Human-readable explanation of why validation failed. */
  message: string;
  /** Stable, machine-readable validation issue code from {@link ValidationIssueCode}. */
  code: string;
}

/**
 * One structured validation problem attached to a {@link ValidationException}.
 * Every validator in the API emits details in this canonical shape so clients
 * can rely on a single format regardless of which endpoint rejected the input.
 */
export interface ValidationErrorDetail {
  /**
   * Property path, e.g. `recipientAddress`, `configuration.threshold` or
   * `budget.limits[0].amount`. Array indices use brackets so client form
   * libraries can map a detail back onto the exact field.
   */
  path: string;
  /** Stable machine-readable Zod issue code, e.g. `invalid_type`, `too_small`. */
  code: string;
  /** Human-readable description of the failed rule. */
  message: string;
}

/**
 * Flattens a Zod issue path into the client-facing format: object keys are
 * dot-separated and array indices are bracketed. Zod itself represents an
 * array element as `['budget', 'limits', 0, 'amount']`; joining with dots would
 * produce `budget.limits.0.amount`, which does not identify a real JSON path.
 */
export function formatZodPath(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((flattened, segment) => {
    if (typeof segment === 'number') {
      return `${flattened}[${segment}]`;
    }
    return flattened.length === 0 ? String(segment) : `${flattened}.${segment}`;
  }, '');
}

/**
 * Flattens a Zod issue path into standard dot-joined notation for the uniform
 * validation error envelope: `user.email`, `items.0.name`.
 */
export function formatZodDotPath(path: ReadonlyArray<string | number>): string {
  return path.map(String).join('.');
}

/**
 * Maps a Zod issue code to a stable, documented {@link ValidationIssueCode}.
 * Prevents leaking raw Zod internal issue names across the public API.
 */
export function mapZodIssueCode(issue: {
  code: string;
  message?: string;
  received?: string;
}): ValidationIssueCode {
  if (issue.code === 'invalid_type') {
    if (
      issue.received === 'undefined' ||
      (issue.message && issue.message.toLowerCase().includes('required'))
    ) {
      return ValidationIssueCode.REQUIRED;
    }
    return ValidationIssueCode.INVALID_TYPE;
  }

  switch (issue.code) {
    case 'too_small':
      return ValidationIssueCode.TOO_SMALL;
    case 'too_big':
      return ValidationIssueCode.TOO_BIG;
    case 'invalid_string':
      return ValidationIssueCode.INVALID_STRING;
    case 'invalid_enum_value':
      return ValidationIssueCode.INVALID_ENUM;
    case 'invalid_date':
      return ValidationIssueCode.INVALID_DATE;
    case 'invalid_literal':
      return ValidationIssueCode.INVALID_LITERAL;
    case 'unrecognized_keys':
      return ValidationIssueCode.UNRECOGNIZED_KEYS;
    case 'custom':
      return ValidationIssueCode.CUSTOM;
    default:
      return ValidationIssueCode.INVALID_VALUE;
  }
}

/**
 * Canonical conversion of a Zod parse failure into the shared
 * `ValidationErrorDetail[]` shape used by every validation pipe and validator.
 */
export function formatZodError(error: ZodError): ValidationErrorDetail[] {
  return error.issues.map((issue) => ({
    path: formatZodPath(issue.path),
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Converts a Zod parse failure into the uniform `{ path, message, code }` items
 * with dot-joined paths and stable `ValidationIssueCode` codes.
 */
export function formatZodValidationErrors(error: ZodError): ValidationErrorItem[] {
  return error.issues.map((issue) => ({
    path: formatZodDotPath(issue.path),
    message: issue.message,
    code: mapZodIssueCode(issue as { code: string; message?: string; received?: string }),
  }));
}
