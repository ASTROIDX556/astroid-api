import { ZodError } from 'zod';

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
    return flattened.length === 0 ? segment : `${flattened}.${segment}`;
  }, '');
}

/**
 * Canonical conversion of a Zod parse failure into the shared
 * `ValidationErrorDetail[]` shape used by every validation pipe and validator.
 *
 * Replaces the ad-hoc `issues.map(...)` blocks that were previously duplicated
 * across `ZodValidationPipe`, `StellarMemoPipe`, `StellarAddressPipe` and the
 * policy service, so error formatting stays consistent app-wide.
 */
export function formatZodError(error: ZodError): ValidationErrorDetail[] {
  return error.issues.map((issue) => ({
    path: formatZodPath(issue.path),
    code: issue.code,
    message: issue.message,
  }));
}
