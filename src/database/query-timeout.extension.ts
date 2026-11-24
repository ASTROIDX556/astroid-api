import {
  ConnectionPoolExhaustedError,
  DatabaseError,
  DatabaseTimeoutError,
} from './database.errors';

export interface QueryTimeoutExtensionOptions {
  /**
   * Client-side guard in milliseconds. Queries that do not settle within this
   * window reject with `DatabaseTimeoutError` (0 disables the guard). The
   * underlying statement is still aborted server-side by `statement_timeout`.
   */
  queryTimeoutMs: number;
  /**
   * Milliseconds a query waits for a pooled connection before the pool
   * exhaustion error (Prisma P2024) is surfaced as a structured error.
   */
  poolTimeoutMs: number;
}

/**
 * The object shape accepted by `PrismaClient.$extends`. `$extends` also accepts
 * a function form, so the object form is declared explicitly here.
 */
export interface PrismaClientExtension {
  name: string;
  query: {
    $allOperations: (params: {
      // `model` is undefined for raw operations ($queryRaw / $executeRaw).
      model?: string;
      operation: string;
      args: unknown;
      query: (args: unknown) => Promise<unknown>;
    }) => Promise<unknown>;
  };
}

/**
 * Runs `task` against a timeout race. When the timeout wins, the promise
 * rejects with a structured `DatabaseTimeoutError` so callers fail fast instead
 * of pinning a pooled connection and blocking the event loop indefinitely.
 */
export async function withQueryTimeout<T>(
  task: () => Promise<T>,
  options: { timeoutMs: number; operation?: string; model?: string },
): Promise<T> {
  const { timeoutMs, operation, model } = options;
  if (timeoutMs <= 0) {
    return task();
  }

  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new DatabaseTimeoutError({
          operation,
          model,
          timeoutMs,
          durationMs: Date.now() - startedAt,
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Maps a raw Prisma failure to a structured database error. Prisma error code
 * `P2024` ("Timed out fetching a new connection from the connection pool")
 * becomes a `ConnectionPoolExhaustedError`; all other errors pass through.
 */
export function mapDatabaseError(
  error: unknown,
  context: { operation?: string; model?: string; poolTimeoutMs: number },
): unknown {
  if (error instanceof DatabaseError) {
    return error;
  }
  if (isPrismaPoolTimeoutError(error)) {
    return new ConnectionPoolExhaustedError({
      operation: context.operation,
      model: context.model,
      poolTimeoutMs: context.poolTimeoutMs,
      cause: error,
    });
  }
  return error;
}

/**
 * Structural check for Prisma's pool-acquisition timeout (error code P2024).
 * Kept structural so the guard works regardless of the generated client's
 * exact error class hierarchy.
 */
function isPrismaPoolTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2024'
  );
}

/**
 * Builds the Prisma client extension that enforces query timeouts and converts
 * pool exhaustion into structured errors. Applied to the API client via
 * `$extends`; every model operation (and `$queryRaw`/`$executeRaw`) flows
 * through the `$allOperations` hook.
 */
export function createQueryTimeoutExtension(
  options: QueryTimeoutExtensionOptions,
): PrismaClientExtension {
  return {
    name: 'queryTimeoutGuard',
    query: {
      async $allOperations({ operation, model, args, query }) {
        try {
          return await withQueryTimeout(() => query(args), {
            timeoutMs: options.queryTimeoutMs,
            operation,
            model,
          });
        } catch (error) {
          throw mapDatabaseError(error, {
            operation,
            model,
            poolTimeoutMs: options.poolTimeoutMs,
          });
        }
      },
    },
  };
}
