import { HttpException } from '@nestjs/common';
import { ERROR_STATUS, ErrorCode } from '../constants/error-codes';

/**
 * Base class for every domain-level failure. Carries a machine-readable
 * `ErrorCode` that the global exception filter serialises into the standard
 * error envelope. Prefer these over raw NestJS HTTP exceptions in services.
 */
export class DomainException extends HttpException {
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message, ERROR_STATUS[code] ?? 500);
    this.code = code;
    this.details = details;
  }
}

export class NotFoundException extends DomainException {
  constructor(entity: string, id?: string) {
    super(ErrorCode.NOT_FOUND, id ? `${entity} '${id}' not found` : `${entity} not found`);
  }
}

export class ValidationException extends DomainException {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.VALIDATION_ERROR, message, details);
  }
}

export class ConflictException extends DomainException {
  constructor(message: string) {
    super(ErrorCode.CONFLICT, message);
  }
}

export class UnauthorizedException extends DomainException {
  constructor(message = 'Authentication required', code: ErrorCode = ErrorCode.UNAUTHORIZED) {
    super(code, message);
  }
}

export class ForbiddenException extends DomainException {
  constructor(message = 'Insufficient permissions') {
    super(ErrorCode.FORBIDDEN, message);
  }
}

export class PolicyViolationException extends DomainException {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.POLICY_VIOLATION, message, details);
  }
}

export class BudgetExceededException extends DomainException {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.BUDGET_EXCEEDED, message, details);
  }
}

export class RiskTooHighException extends DomainException {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.RISK_TOO_HIGH, message, details);
  }
}

/**
 * A documented endpoint whose implementation is intentionally deferred (e.g.
 * WebAuthn passkeys, which require the `@simplewebauthn/server` package and a
 * configured relying party). Returns 501 so clients receive an honest, typed
 * signal instead of a confusing 404 — see user_task.md / latter.md.
 */
export class NotImplementedException extends DomainException {
  constructor(message = 'This endpoint is not implemented yet') {
    super(ErrorCode.NOT_IMPLEMENTED, message);
  }
}

export class VelocityLimitExceededException extends DomainException {
  constructor(message: string, details?: unknown) {
    super(ErrorCode.POLICY_VIOLATION, message, details);
  }
}

/**
 * Thrown by a {@link CircuitBreaker} (see `src/common/circuit-breaker`) when
 * it fails fast because its circuit is OPEN, instead of invoking a degraded
 * downstream dependency (e.g. Horizon/Soroban RPC). Distinguishable from a
 * genuine `STELLAR_ERROR` so callers can special-case "try again shortly"
 * behaviour using `retryAfterMs`.
 */
export class CircuitOpenException extends DomainException {
  constructor(integration: string, retryAfterMs: number) {
    super(
      ErrorCode.CIRCUIT_OPEN,
      `Circuit breaker for '${integration}' is open; failing fast to protect the caller`,
      { integration, state: 'OPEN', retryAfterMs },
    );
  }
}

/**
 * Thrown by a distributed lock (see `src/common/locks`) when the lock for a
 * resource could not be acquired within the allowed attempts — i.e. another
 * request/process is already mutating the same resource. Maps to a 409 so
 * clients can treat concurrent state mutations as a transient conflict and
 * retry (or surface a "please try again" message).
 */
export class LockNotAcquiredException extends DomainException {
  constructor(resource: string, details?: unknown) {
    super(
      ErrorCode.LOCK_ACQUISITION_FAILED,
      `Another request is currently modifying this resource: '${resource}'. Please retry shortly.`,
      details,
    );
  }
}
