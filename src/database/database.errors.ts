/**
 * Structured database error types.
 *
 * The query-timeout guard converts raw Prisma failures into these typed errors
 * so callers (and the exception filter / logs) can distinguish:
 *   - a query that exceeded its configured timeout  → DatabaseTimeoutError
 *   - a connection pool that could not be acquired  → ConnectionPoolExhaustedError
 *
 * Both carry stable `code` strings and machine-readable metadata for alerting.
 */

export type DatabaseErrorCode = 'DB_QUERY_TIMEOUT' | 'DB_POOL_EXHAUSTED';

export interface DatabaseErrorContext {
  operation?: string;
  model?: string;
  cause?: unknown;
}

/** Base class for all structured database errors thrown by the Prisma layer. */
export abstract class DatabaseError extends Error {
  abstract readonly code: DatabaseErrorCode;
  readonly operation?: string;
  readonly model?: string;
  readonly cause?: unknown;

  protected constructor(message: string, context: DatabaseErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.operation = context.operation;
    this.model = context.model;
    this.cause = context.cause;
  }
}

/**
 * Raised when a query does not complete within the configured client-side
 * timeout. The underlying statement is still aborted server-side by
 * `statement_timeout`, which releases the pooled connection.
 */
export class DatabaseTimeoutError extends DatabaseError {
  readonly code = 'DB_QUERY_TIMEOUT' as const;
  readonly timeoutMs: number;
  readonly durationMs: number;

  constructor(context: {
    operation?: string;
    model?: string;
    timeoutMs: number;
    durationMs: number;
    cause?: unknown;
  }) {
    const target = context.model ?? 'query';
    const op = context.operation ? `.${context.operation}` : '';
    super(
      `Database query timed out after ${context.timeoutMs}ms (${target}${op}, actual ${context.durationMs}ms)`,
      context,
    );
    this.timeoutMs = context.timeoutMs;
    this.durationMs = context.durationMs;
  }
}

/**
 * Raised when no connection could be acquired from the pool within
 * `poolTimeoutMs` (Prisma error P2024). This is the fast-failure signal for
 * connection pool exhaustion under heavy load.
 */
export class ConnectionPoolExhaustedError extends DatabaseError {
  readonly code = 'DB_POOL_EXHAUSTED' as const;
  readonly poolTimeoutMs: number;

  constructor(context: {
    operation?: string;
    model?: string;
    poolTimeoutMs: number;
    cause?: unknown;
  }) {
    super(
      `Database connection pool exhausted: no connection available after ${context.poolTimeoutMs}ms` +
        (context.model ? ` for ${context.model}${context.operation ? `.${context.operation}` : ''}` : ''),
      context,
    );
    this.poolTimeoutMs = context.poolTimeoutMs;
  }
}
