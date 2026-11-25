import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CircuitBreaker,
  CircuitState,
  isRpcFailure,
  CircuitStateEventPayload,
} from '../../common/circuit-breaker/circuit-breaker';
import { CircuitOpenException, DomainException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';

/**
 * Configuration for the Horizon circuit breaker, read from the Stellar config
 * namespace. These values can be overridden via environment variables:
 *   - STELLAR_CIRCUIT_BREAKER_FAILURE_THRESHOLD
 *   - STELLAR_CIRCUIT_BREAKER_RESET_TIMEOUT_MS
 *   - STELLAR_CIRCUIT_BREAKER_HALF_OPEN_MAX_ATTEMPTS
 */
export interface HorizonCircuitBreakerConfig {
  /** Consecutive failures (while CLOSED) required to trip the circuit open. */
  failureThreshold: number;
  /** Time the circuit stays OPEN before allowing a HALF_OPEN trial call (ms). */
  resetTimeoutMs: number;
  /** Trial calls permitted while HALF_OPEN before the outcome is decided. */
  halfOpenMaxAttempts: number;
}

/**
 * Structured fallback response returned when the circuit is OPEN and the
 * downstream Horizon dependency is unavailable. Callers can use the fallback
 * data to degrade gracefully instead of propagating an error to the caller.
 */
export interface HorizonFallbackResponse {
  /** Whether this response was produced by the fallback path. */
  isFallback: true;
  /** The name of the circuit breaker that tripped. */
  circuitName: string;
  /** When the fallback was triggered. */
  timestamp: number;
  /** Time in ms before the circuit will attempt a recovery probe. */
  retryAfterMs: number;
  /** Optional cached/stale data that can be used for degraded reads. */
  cachedData?: unknown;
}

/**
 * Interface for fallback strategy implementations. Callers provide a concrete
 * implementation that returns domain-specific fallback data when the circuit
 * opens (e.g. a cached balance, a stale transaction state, or a null/empty
 * response that the UI can render as "temporarily unavailable").
 */
export interface FallbackStrategy<T = unknown> {
  /** Human-readable name for logging and diagnostics. */
  name: string;
  /**
   * Produces a fallback value when the circuit is open.
   * Called synchronously or asynchronously — the circuit breaker handles both.
   */
  execute(): Promise<T> | T;
}

const DEFAULT_CONFIG: HorizonCircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 2,
};

/**
 * Service wrapping a {@link CircuitBreaker} for Stellar Horizon RPC calls with:
 *   - Configurable thresholds via ConfigService (environment variables)
 *   - Registered fallback strategies per operation type
 *   - Structured fallback responses with metadata
 *   - Event emission for monitoring integration
 *
 * This service is injected into the Stellar integration layer so that all
 * outbound Horizon requests are protected from cascading failures. When Horizon
 * degrades (5xx responses, connection timeouts, DNS failures), the circuit trips
 * OPEN and subsequent calls fail fast — either by invoking a registered fallback
 * or by throwing a structured {@link CircuitOpenException}.
 *
 * Half-open recovery probing is automatic: after `resetTimeoutMs` has elapsed,
 * trial calls are allowed through to probe whether Horizon has recovered.
 *
 * Thread safety: state is kept in process memory (a single CircuitBreaker
 * instance) which is safe because NestJS providers are singletons. Concurrent
 * requests share the same breaker state and transition atomically.
 */
@Injectable()
export class HorizonCircuitBreakerService {
  private readonly logger = new Logger(HorizonCircuitBreakerService.name);

  private readonly breaker: CircuitBreaker;
  private readonly fallbackStrategies = new Map<string, FallbackStrategy>();

  constructor(private readonly config: ConfigService) {
    const cbConfig = this.resolveConfig();
    this.breaker = new CircuitBreaker({
      name: 'horizon',
      failureThreshold: cbConfig.failureThreshold,
      resetTimeoutMs: cbConfig.resetTimeoutMs,
      halfOpenMaxAttempts: cbConfig.halfOpenMaxAttempts,
      isFailure: isRpcFailure,
    });

    this.attachEventListeners();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Executes an Horizon RPC operation through the circuit breaker.
   *
   * When the circuit is OPEN:
   *   1. If a fallback strategy is registered for `operationName`, it is
   *      invoked and its result returned.
   *   2. Otherwise, a {@link CircuitOpenException} is thrown.
   *
   * @param operationName - Identifier for fallback lookup (e.g. "getBalances").
   * @param operation - The async operation to execute through the breaker.
   * @param fallbackStrategy - Optional fallback strategy to invoke on circuit open.
   * @returns The result of `operation` or the fallback value.
   */
  async executeWithFallback<T>(
    operationName: string,
    operation: () => Promise<T>,
    fallbackStrategy?: FallbackStrategy<T>,
  ): Promise<T> {
    const strategy = fallbackStrategy ?? this.fallbackStrategies.get(operationName);

    try {
      return await this.breaker.execute(operation);
    } catch (error) {
      if (error instanceof CircuitOpenException && strategy) {
        return this.invokeFallback(operationName, strategy, error);
      }
      throw error;
    }
  }

  /**
   * Registers a fallback strategy for a named operation. When the circuit is
   * open and a call with the matching operation name is made, this strategy
   * will be invoked automatically.
   */
  registerFallback(operationName: string, strategy: FallbackStrategy): void {
    this.fallbackStrategies.set(operationName, strategy);
    this.logger.debug(`Registered fallback strategy '${strategy.name}' for operation '${operationName}'`);
  }

  /**
   * Removes a registered fallback strategy for a named operation.
   */
  unregisterFallback(operationName: string): boolean {
    return this.fallbackStrategies.delete(operationName);
  }

  /** Returns the current circuit state. */
  getState(): CircuitState {
    return this.breaker.getState();
  }

  /** Returns the current consecutive failure count. */
  getFailureCount(): number {
    return this.breaker.getFailureCount();
  }

  /** Returns the breaker name. */
  getName(): string {
    return this.breaker.getName();
  }

  /**
   * Returns a snapshot of the circuit breaker's current state, useful for
   * health endpoints and monitoring dashboards.
   */
  getSnapshot(): {
    name: string;
    state: CircuitState;
    failureCount: number;
    registeredFallbacks: string[];
  } {
    return {
      name: this.breaker.getName(),
      state: this.breaker.getState(),
      failureCount: this.breaker.getFailureCount(),
      registeredFallbacks: Array.from(this.fallbackStrategies.keys()),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolves circuit breaker configuration from ConfigService with fallback
   * to sensible defaults. Reads from the Stellar config namespace if available,
   * or directly from environment variables.
   */
  private resolveConfig(): HorizonCircuitBreakerConfig {
    const envThreshold = this.config.get<number>('STELLAR_CIRCUIT_BREAKER_FAILURE_THRESHOLD');
    const envResetTimeout = this.config.get<number>('STELLAR_CIRCUIT_BREAKER_RESET_TIMEOUT_MS');
    const envHalfOpenAttempts = this.config.get<number>('STELLAR_CIRCUIT_BREAKER_HALF_OPEN_MAX_ATTEMPTS');

    return {
      failureThreshold: envThreshold ?? DEFAULT_CONFIG.failureThreshold,
      resetTimeoutMs: envResetTimeout ?? DEFAULT_CONFIG.resetTimeoutMs,
      halfOpenMaxAttempts: envHalfOpenAttempts ?? DEFAULT_CONFIG.halfOpenMaxAttempts,
    };
  }

  /**
   * Invokes a fallback strategy, wrapping errors as STELLAR_ERROR domain
   * exceptions if the fallback itself fails.
   */
  private async invokeFallback<T>(
    operationName: string,
    strategy: FallbackStrategy,
    circuitError: CircuitOpenException,
  ): Promise<T> {
    try {
      this.logger.warn(
        `Circuit breaker for '${operationName}' is open; invoking fallback '${strategy.name}'`,
      );
      // The strategy is stored as FallbackStrategy (unknown) in the Map,
      // but at runtime it was registered with the correct type via
      // executeWithFallback<T>. The cast is safe because the Map stores
      // the concrete implementation.
      const result = await (strategy as FallbackStrategy<unknown>).execute();
      return result as T;
    } catch (fallbackError) {
      this.logger.error(
        `Fallback strategy '${strategy.name}' for '${operationName}' failed: ${(fallbackError as Error).message}`,
      );
      throw new DomainException(
        ErrorCode.STELLAR_ERROR,
        `Horizon fallback for '${operationName}' failed: ${(fallbackError as Error).message}`,
        {
          operationName,
          circuitState: 'OPEN',
          retryAfterMs: circuitError.details
            ? (circuitError.details as { retryAfterMs?: number }).retryAfterMs ?? 0
            : 0,
        },
      );
    }
  }

  /**
   * Attaches monitoring event listeners to the underlying breaker. These are
   * purely observational — they log state transitions and never mutate state.
   */
  private attachEventListeners(): void {
    this.breaker.on('open', (payload: CircuitStateEventPayload) => {
      this.logger.warn(
        `Circuit breaker '${payload.name}' OPENED after ${payload.failureCount} consecutive failures`,
      );
    });

    this.breaker.on('half_open', (payload: CircuitStateEventPayload) => {
      this.logger.log(
        `Circuit breaker '${payload.name}' transitioning to HALF_OPEN for recovery probe`,
      );
    });

    this.breaker.on('close', (payload: CircuitStateEventPayload) => {
      this.logger.log(
        `Circuit breaker '${payload.name}' CLOSED — downstream dependency recovered`,
      );
    });
  }
}
