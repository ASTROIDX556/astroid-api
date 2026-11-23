import { Logger } from '@nestjs/common';
import {
  CircuitBreaker,
  CircuitState,
  CircuitStateEventPayload,
} from '../../common/circuit-breaker/circuit-breaker';
import { ErrorCode } from '../../common/constants/error-codes';
import { CircuitOpenException, DomainException } from '../../common/exceptions/domain.exception';
import { jitteredBackoffDelay } from '../../utils/backoff.util';

/**
 * Why a Soroban RPC call is considered an outage rather than a bad request.
 *
 * - `timeout`          – no response within {@link SorobanRpcClientOptions.timeoutMs}
 * - `network`          – connection refused/reset, DNS failure, socket error
 * - `server_error`     – HTTP 5xx
 * - `rate_limited`     – HTTP 429
 * - `invalid_response` – a 2xx whose body is not a JSON-RPC response
 * - `circuit_open`     – the breaker is open; the endpoint was not called
 */
export type SorobanUnavailableReason =
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'rate_limited'
  | 'invalid_response'
  | 'circuit_open';

export interface SorobanUnavailableDetails {
  endpoint: string;
  method: string;
  reason: SorobanUnavailableReason;
  /** Attempts made before giving up (0 when the circuit failed fast). */
  attempts: number;
  /** HTTP status of the last response, when there was one. */
  status?: number;
  /** Milliseconds until the breaker will allow a probe (circuit_open only). */
  retryAfterMs?: number;
}

/**
 * The Soroban RPC endpoint is unavailable (timeouts, connection errors, 5xx,
 * 429 after retries were exhausted, or an open circuit). Maps to 503
 * `SOROBAN_UNAVAILABLE` in the standard error envelope.
 */
export class SorobanUnavailableException extends DomainException {
  declare readonly details: SorobanUnavailableDetails;

  constructor(message: string, details: SorobanUnavailableDetails) {
    super(ErrorCode.SOROBAN_UNAVAILABLE, message, details);
  }
}

export interface SorobanRequestRejectedDetails {
  endpoint: string;
  method: string;
  /** HTTP status when the endpoint answered 4xx (other than 429). */
  status?: number;
  /** JSON-RPC error code when the endpoint answered with an error object. */
  rpcCode?: number;
}

/**
 * The Soroban RPC endpoint rejected the request: an HTTP 4xx other than 429,
 * or a JSON-RPC `error` object. Never retried and never counted against the
 * circuit breaker. Maps to 400 `SOROBAN_REQUEST_REJECTED`.
 */
export class SorobanRequestRejectedException extends DomainException {
  declare readonly details: SorobanRequestRejectedDetails;

  constructor(message: string, details: SorobanRequestRejectedDetails) {
    super(ErrorCode.SOROBAN_REQUEST_REJECTED, message, details);
  }
}

/** A failed attempt that may succeed if retried. Internal to this module. */
class TransientRpcError extends Error {
  constructor(
    readonly reason: Exclude<SorobanUnavailableReason, 'circuit_open'>,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransientRpcError';
  }
}

/** Minimal `fetch` surface the client depends on, so tests can stub it. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

export interface SorobanRpcClientOptions {
  /** Soroban RPC endpoint URL. */
  endpoint: string;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Total attempts per call, including the first (1 disables retries). */
  maxAttempts: number;
  /** Base delay for the jittered exponential backoff between attempts. */
  retryBaseDelayMs: number;
  /** Upper bound for a single backoff delay. */
  retryMaxDelayMs: number;
  /** Consecutive failed attempts that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before a single half-open probe. */
  cooldownMs: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Injected for tests; defaults to a Nest logger named after the class. */
  logger?: Pick<Logger, 'log' | 'warn'>;
}

/** Defaults used when no configuration is supplied (see docs/configuration.md). */
export const DEFAULT_SOROBAN_RPC_OPTIONS = {
  timeoutMs: 5_000,
  maxAttempts: 3,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 2_000,
  failureThreshold: 5,
  cooldownMs: 30_000,
} as const satisfies Omit<SorobanRpcClientOptions, 'endpoint'>;

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: unknown;
  result?: T;
  error?: { code?: number; message?: string };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The single wrapper every Soroban JSON-RPC call goes through. It enforces:
 *
 * - **Timeout** – each attempt is aborted with an `AbortController` after
 *   `timeoutMs`.
 * - **Bounded retries** – only timeouts, connection errors, HTTP 5xx and 429
 *   are retried, up to `maxAttempts` in total, with jittered exponential
 *   backoff. Any other 4xx, and every JSON-RPC `error` object, fails after one
 *   attempt with {@link SorobanRequestRejectedException}.
 * - **Circuit breaker** – `failureThreshold` consecutive failed attempts open
 *   the circuit for `cooldownMs`; calls then fail fast with
 *   {@link SorobanUnavailableException} (`reason: 'circuit_open'`). After the
 *   cooldown exactly one probe attempt is let through (half-open): success
 *   closes the circuit, failure reopens it for another cooldown.
 *
 * Breaker state is per endpoint and in process memory: one client instance
 * serves one endpoint, and Nest providers are singletons, so the state lives
 * for the life of the process. Replicas each keep their own breaker, which is
 * fine for fail-fast protection and avoids a Redis round trip per RPC call.
 */
export class SorobanRpcClient {
  private readonly options: SorobanRpcClientOptions;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Pick<Logger, 'log' | 'warn'>;
  private readonly breaker: CircuitBreaker;
  private requestId = 0;

  constructor(options: SorobanRpcClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.logger = options.logger ?? new Logger(SorobanRpcClient.name);
    this.breaker = new CircuitBreaker({
      name: `soroban-rpc:${options.endpoint}`,
      failureThreshold: options.failureThreshold,
      resetTimeoutMs: options.cooldownMs,
      halfOpenMaxAttempts: 1,
      // Only outages count; a rejected request says nothing about health.
      isFailure: (error) => error instanceof TransientRpcError,
    });
    this.breaker.on('open', (event: CircuitStateEventPayload) => this.logTransition(event));
    this.breaker.on('half_open', (event: CircuitStateEventPayload) => this.logTransition(event));
    this.breaker.on('close', (event: CircuitStateEventPayload) => this.logTransition(event));
  }

  get endpoint(): string {
    return this.options.endpoint;
  }

  /** Current breaker state, for health checks and tests. */
  getCircuitState(): CircuitState {
    return this.breaker.getState();
  }

  /**
   * Invokes a JSON-RPC `method` and returns its typed `result`.
   *
   * @throws SorobanUnavailableException     on outage (after retries) or open circuit
   * @throws SorobanRequestRejectedException on a non-retryable rejection
   */
  async call<TResult>(method: string, params?: Record<string, unknown>): Promise<TResult> {
    const { maxAttempts, retryBaseDelayMs, retryMaxDelayMs } = this.options;
    let lastError: TransientRpcError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.breaker.execute(() => this.attempt<TResult>(method, params));
      } catch (error) {
        if (error instanceof CircuitOpenException) {
          throw this.circuitOpenError(method, attempt - 1, error, lastError);
        }
        if (!(error instanceof TransientRpcError)) {
          throw error;
        }
        lastError = error;
        if (attempt < maxAttempts) {
          const delay = jitteredBackoffDelay(attempt, retryBaseDelayMs, retryMaxDelayMs);
          this.logger.warn(
            `Soroban RPC ${method} attempt ${attempt}/${maxAttempts} to ${this.endpoint} failed ` +
              `(${error.reason}); retrying in ${delay}ms`,
          );
          await sleep(delay);
        }
      }
    }

    const final = lastError as TransientRpcError;
    throw new SorobanUnavailableException(
      `Soroban RPC ${method} failed after ${maxAttempts} attempt(s): ${final.message}`,
      {
        endpoint: this.endpoint,
        method,
        reason: final.reason,
        attempts: maxAttempts,
        ...(final.status !== undefined ? { status: final.status } : {}),
      },
    );
  }

  /** One HTTP round trip with its own timeout. */
  private async attempt<TResult>(method: string, params?: Record<string, unknown>): Promise<TResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, ...(params ? { params } : {}) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new TransientRpcError('timeout', `timed out after ${this.options.timeoutMs}ms`);
      }
      throw new TransientRpcError('network', networkErrorMessage(error));
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new TransientRpcError('rate_limited', 'HTTP 429 Too Many Requests', 429);
    }
    if (response.status >= 500) {
      throw new TransientRpcError('server_error', `HTTP ${response.status}`, response.status);
    }
    if (!response.ok) {
      throw new SorobanRequestRejectedException(
        `Soroban RPC rejected ${method} with HTTP ${response.status}`,
        { endpoint: this.endpoint, method, status: response.status },
      );
    }

    let body: JsonRpcResponse<TResult>;
    try {
      body = (await response.json()) as JsonRpcResponse<TResult>;
    } catch {
      throw new TransientRpcError('invalid_response', 'response body is not valid JSON', response.status);
    }
    if (!body || typeof body !== 'object') {
      throw new TransientRpcError('invalid_response', 'response is not a JSON-RPC object', response.status);
    }
    if (body.error) {
      throw new SorobanRequestRejectedException(
        `Soroban RPC ${method} returned an error: ${body.error.message ?? 'unknown error'}`,
        { endpoint: this.endpoint, method, ...(typeof body.error.code === 'number' ? { rpcCode: body.error.code } : {}) },
      );
    }
    if (!('result' in body)) {
      throw new TransientRpcError('invalid_response', 'JSON-RPC response has no result', response.status);
    }
    return body.result as TResult;
  }

  private circuitOpenError(
    method: string,
    attempts: number,
    error: CircuitOpenException,
    lastError?: TransientRpcError,
  ): SorobanUnavailableException {
    const retryAfterMs = (error.details as { retryAfterMs?: number } | undefined)?.retryAfterMs;
    return new SorobanUnavailableException(
      `Soroban RPC circuit for ${this.endpoint} is open; failing fast`,
      {
        endpoint: this.endpoint,
        method,
        reason: 'circuit_open',
        attempts,
        ...(lastError?.status !== undefined ? { status: lastError.status } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    );
  }

  private logTransition(event: CircuitStateEventPayload): void {
    const message =
      `Soroban RPC circuit ${event.state} for ${this.endpoint} ` +
      `(consecutive failures: ${event.failureCount})`;
    if (event.state === CircuitState.CLOSED) {
      this.logger.log(message);
    } else {
      this.logger.warn(message);
    }
  }
}

function networkErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { code?: unknown } }).cause;
    const code = cause && typeof cause.code === 'string' ? cause.code : undefined;
    return code ? `${error.message} (${code})` : error.message;
  }
  return 'connection failed';
}
