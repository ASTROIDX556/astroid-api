import { EventEmitter } from 'events';
import { CircuitOpenException, DomainException } from '../exceptions/domain.exception';

/**
 * The three states of the circuit breaker state machine.
 *
 *   CLOSED    → calls flow through normally; consecutive failures are counted.
 *   OPEN      → calls fail fast (the wrapped operation is never invoked) until
 *               `resetTimeoutMs` has elapsed since the circuit opened.
 *   HALF_OPEN → a limited number of trial calls are allowed through to probe
 *               whether the downstream dependency has recovered.
 */
export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  /** Identifies this breaker instance in logs, events, and thrown errors. */
  name: string;
  /** Consecutive failures (while CLOSED) required to trip the circuit open. */
  failureThreshold: number;
  /** Time the circuit stays OPEN before allowing a HALF_OPEN trial call. */
  resetTimeoutMs: number;
  /** Trial calls permitted while HALF_OPEN before the outcome is decided. Default: 1. */
  halfOpenMaxAttempts?: number;
  /**
   * Classifies whether a thrown error should count against the failure
   * threshold. Defaults to treating every thrown error as a failure.
   */
  isFailure?: (error: unknown) => boolean;
}

export interface CircuitStateEventPayload {
  /** Name of the breaker that transitioned. */
  name: string;
  /** The state being entered. */
  state: CircuitState;
  /** `Date.now()` at the moment of transition. */
  timestamp: number;
  /** Consecutive failure count at the moment of transition. */
  failureCount: number;
}

export interface CircuitOutcomeEventPayload {
  name: string;
  timestamp: number;
}

export interface CircuitFailureEventPayload extends CircuitOutcomeEventPayload {
  error: unknown;
  failureCount: number;
}

/** Strongly typed event names emitted by {@link CircuitBreaker}. */
export interface CircuitBreakerEvents {
  open: (payload: CircuitStateEventPayload) => void;
  half_open: (payload: CircuitStateEventPayload) => void;
  close: (payload: CircuitStateEventPayload) => void;
  success: (payload: CircuitOutcomeEventPayload) => void;
  failure: (payload: CircuitFailureEventPayload) => void;
}

/**
 * A reusable, DI-free circuit breaker for protecting external RPC calls
 * (Stellar Horizon, Soroban RPC, etc.) from cascading failures.
 *
 * State is kept in process memory — instantiate one breaker per logical
 * integration (e.g. `new CircuitBreaker({ name: 'horizon', ... })`) and reuse
 * it across calls; since NestJS providers are singletons by default, a
 * breaker constructed as a private field on a service naturally persists
 * failure/state tracking for the lifetime of the process.
 *
 * Emits `'open'`, `'half_open'`, `'close'`, `'success'`, and `'failure'`
 * events for monitoring; consumers can `breaker.on('open', handler)`.
 */
export class CircuitBreaker extends EventEmitter {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;
  private readonly isFailure: (error: unknown) => boolean;

  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private openedAt: number | null = null;
  private halfOpenAttempts = 0;

  constructor(options: CircuitBreakerOptions) {
    super();
    this.name = options.name;
    this.failureThreshold = options.failureThreshold;
    this.resetTimeoutMs = options.resetTimeoutMs;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? 1;
    this.isFailure = options.isFailure ?? ((): boolean => true);
  }

  getName(): string {
    return this.name;
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Executes `operation` through the circuit breaker.
   *
   * - CLOSED: runs `operation`; consecutive classified failures trip the
   *   breaker OPEN once `failureThreshold` is reached.
   * - OPEN (within `resetTimeoutMs` of opening): fails fast — `operation` is
   *   never invoked. Calls `fallback()` if provided, otherwise throws
   *   {@link CircuitOpenException}.
   * - OPEN (after `resetTimeoutMs` has elapsed): transitions to HALF_OPEN and
   *   allows up to `halfOpenMaxAttempts` trial calls through.
   * - HALF_OPEN: a successful trial closes the circuit (resets the failure
   *   count); a failed trial reopens it and resets the reset timer.
   */
  async execute<T>(operation: () => Promise<T>, fallback?: () => Promise<T> | T): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      const elapsed = this.openedAt !== null ? Date.now() - this.openedAt : this.resetTimeoutMs;
      if (elapsed < this.resetTimeoutMs) {
        return this.handleFailFast(fallback);
      }
      this.transitionTo(CircuitState.HALF_OPEN);
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        return this.handleFailFast(fallback);
      }
      this.halfOpenAttempts += 1;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private async handleFailFast<T>(fallback?: () => Promise<T> | T): Promise<T> {
    if (fallback) {
      return await fallback();
    }
    const retryAfterMs =
      this.openedAt !== null
        ? Math.max(this.resetTimeoutMs - (Date.now() - this.openedAt), 0)
        : this.resetTimeoutMs;
    throw new CircuitOpenException(this.name, retryAfterMs);
  }

  private onSuccess(): void {
    this.emit('success', { name: this.name, timestamp: Date.now() } satisfies CircuitOutcomeEventPayload);
    if (this.state === CircuitState.HALF_OPEN) {
      this.transitionTo(CircuitState.CLOSED);
      return;
    }
    this.failureCount = 0;
  }

  private onFailure(error: unknown): void {
    if (!this.isFailure(error)) {
      return;
    }

    this.failureCount += 1;
    this.emit('failure', {
      name: this.name,
      timestamp: Date.now(),
      error,
      failureCount: this.failureCount,
    } satisfies CircuitFailureEventPayload);

    if (this.state === CircuitState.HALF_OPEN) {
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    if (this.state === CircuitState.CLOSED && this.failureCount >= this.failureThreshold) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private transitionTo(state: CircuitState): void {
    this.state = state;
    const timestamp = Date.now();

    if (state === CircuitState.OPEN) {
      this.openedAt = timestamp;
      this.halfOpenAttempts = 0;
      this.emit('open', {
        name: this.name,
        state,
        timestamp,
        failureCount: this.failureCount,
      } satisfies CircuitStateEventPayload);
      return;
    }

    if (state === CircuitState.HALF_OPEN) {
      this.halfOpenAttempts = 0;
      this.emit('half_open', {
        name: this.name,
        state,
        timestamp,
        failureCount: this.failureCount,
      } satisfies CircuitStateEventPayload);
      return;
    }

    // CLOSED
    this.failureCount = 0;
    this.openedAt = null;
    this.halfOpenAttempts = 0;
    this.emit('close', {
      name: this.name,
      state,
      timestamp,
      failureCount: this.failureCount,
    } satisfies CircuitStateEventPayload);
  }
}

/**
 * Classifies common Horizon/Soroban RPC error shapes (network errors and 5xx
 * HTTP responses) as circuit-breaker failures.
 *
 * - `DomainException`s (application/validation errors) never trip the
 *   breaker — they aren't a signal of upstream RPC instability.
 * - Known network error codes (connection refused/reset/timeout, DNS
 *   failures) always count as failures.
 * - HTTP-status-bearing errors count only when the status is >= 500 (server
 *   degradation); 4xx client errors — e.g. a malformed transaction rejected
 *   by Horizon — do not trip the breaker.
 * - Any other thrown error (e.g. a raw SDK/network error with no status)
 *   defaults to counting as a failure, since it originates from the RPC
 *   client call the breaker wraps.
 */
export function isRpcFailure(error: unknown): boolean {
  if (error instanceof DomainException) {
    return false;
  }

  if (error == null || typeof error !== 'object') {
    return true;
  }

  const err = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };

  const networkErrorCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ENETUNREACH',
  ]);
  if (typeof err.code === 'string' && networkErrorCodes.has(err.code)) {
    return true;
  }

  const status = typeof err.status === 'number' ? err.status : err.response?.status;
  if (typeof status === 'number') {
    return status >= 500;
  }

  return true;
}
