import { ZodError } from 'zod';

/**
 * One structured validation problem attached to a {@link ValidationException}.
 * Every validator in the API emits details in this canonical shape so clients
 * can rely on a single format regardless of which endpoint rejected the input.
 */
export interface ValidationErrorDetail {
  /** Dot-joined property path, e.g. `recipientAddress` or `configuration.threshold`. */
  path: string;
  /** Human-readable description of the failed rule. */
  message: string;
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
    path: issue.path.join('.'),
    message: issue.message,
  }));
}
