import { exponentialBackoffWithJitter } from './backoff.util';

export interface RetryOptions<E = unknown> {
  /** Total number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds for the first retry. Default: 500. */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds. Default: 30_000. */
  maxDelayMs?: number;
  /**
   * Return true to allow a retry; false to stop immediately and rethrow.
   * When omitted, every error is retried up to `maxAttempts`.
   */
  isRetryable?: (error: E) => boolean;
  /**
   * Called just before each retry sleep so the caller can log or record
   * metrics without having to duplicate the retry logic.
   */
  onRetry?: (attempt: number, error: E, delayMs: number) => void;
  /** Human-readable label included in the final error message. */
  operationName?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/** Failures at or above this status code are transient and worth retrying. */
const TRANSIENT_STATUS_MIN = 500;
const TRANSIENT_STATUS_MAX = 599;

/** Transport-level error codes that indicate a transient network failure. */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Message fragments that indicate a transient network/transport failure. */
const TRANSIENT_MESSAGE_PATTERN =
  /(timeout|timed[\s_-]*out|econn|epipe|enotfound|eai[\s_-]?again|socket[\s_-]*hang|fetch[\s_-]*failed|network|connection|unreach|unavail|bad[\s_-]*gateway|internal[\s_-]*server|server[\s_-]*error|try[\s_-]*again)/i;

interface ErrorLike {
  status?: unknown;
  statusCode?: unknown;
  response?: unknown;
  getStatus?: () => unknown;
  code?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
  retryable?: unknown;
}

/**
 * Extracts the HTTP status carried by an error, if any.
 *
 * Supports plain `{ status }` / `{ statusCode }` fields as well as errors
 * exposing a `getStatus()` method (common for HTTP client libraries) and
 * `{ response: { status } }` shapes.
 */
function resolveErrorStatus(error: ErrorLike): number | undefined {
  let status: unknown = error.status ?? error.statusCode;
  if (status === undefined && error.response && typeof error.response === 'object') {
    status = (error.response as { status?: unknown }).status;
  }
  if (status === undefined && typeof error.getStatus === 'function') {
    try {
      status = error.getStatus();
    } catch {
      return undefined;
    }
  }
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

interface ErrorSignals {
  codes: string[];
  messages: string[];
}

/**
 * Walks the error and its `cause` chain (bounded depth) collecting transport
 * error codes and message fragments. Network clients usually nest the low-level
 * cause (e.g. `ECONNRESET`) under a generic wrapper error.
 */
function collectErrorSignals(error: unknown, depth = 0): ErrorSignals {
  const signals: ErrorSignals = { codes: [], messages: [] };
  if (error === null || error === undefined || depth > 5) {
    return signals;
  }
  const candidate = error as ErrorLike;
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  if (code) {
    signals.codes.push(code);
  }
  if (typeof candidate.message === 'string') {
    signals.messages.push(candidate.message);
  }
  const nested = collectErrorSignals(candidate.cause, depth + 1);
  signals.codes.push(...nested.codes);
  signals.messages.push(...nested.messages);
  return signals;
}

/**
 * Decides whether an error represents a transient network failure that is
 * safe to retry — i.e. a temporary outage (5xx responses) or a transport-level
 * hiccup (timeouts, connection resets, refused sockets).
 *
 * Deterministic failures are *not* retryable and fail fast instead:
 * - HTTP 4xx responses (e.g. 400 Bad Request from a GraphQL syntax error) and
 *   any other sub-5xx status.
 * - Errors explicitly flagged `retryable: false` (e.g. GraphQL execution
 *   errors such as validation failures).
 *
 * @param error - The error caught by the network layer.
 * @returns true when the failure looks transient and the call may be retried.
 */
export function isTransientNetworkError(error: unknown): boolean {
  const candidate = error as ErrorLike;
  const status = resolveErrorStatus(candidate);
  if (status !== undefined) {
    // 5xx responses come from flaky or overloaded upstream services and are
    // transient; 4xx responses are deterministic client-side failures.
    return status >= TRANSIENT_STATUS_MIN && status <= TRANSIENT_STATUS_MAX;
  }
  if (candidate.retryable === false) {
    // Explicitly classified permanent failures must not be retried.
    return false;
  }
  const { codes, messages } = collectErrorSignals(error);
  return (
    codes.some((code) => TRANSIENT_ERROR_CODES.has(code)) ||
    messages.some((message) => TRANSIENT_MESSAGE_PATTERN.test(message))
  );
}

/**
 * Retries `fn` up to `maxAttempts` times with exponential backoff and
 * jitter.  The first invocation is attempt 1; only failures trigger a retry.
 *
 * @throws The error from the last attempt once all retries are exhausted.
 * @throws Immediately (without waiting for the next retry) when `isRetryable`
 *         returns `false`.
 */
export async function retryWithBackoff<T, E = unknown>(
  fn: () => Promise<T>,
  options: RetryOptions<E> = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    isRetryable,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (isRetryable && !isRetryable(error as E)) {
        throw error;
      }

      if (attempt === maxAttempts) {
        break;
      }

      const raw = exponentialBackoffWithJitter(attempt, baseDelayMs);
      const delayMs = Math.min(raw, maxDelayMs);

      onRetry?.(attempt, error as E, delayMs);

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
