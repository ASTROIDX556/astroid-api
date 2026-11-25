import { Prisma } from '@prisma/client';
import { ERROR_STATUS, ErrorCode } from '../constants/error-codes';

/**
 * Prisma error codes that have a dedicated application mapping. Anything else
 * (and every non-request Prisma error) is treated as an internal fault.
 *
 * @see https://www.prisma.io/docs/orm/reference/error-reference
 */
export const PRISMA_ERROR_CODES = {
  /** Value too long for the column type. */
  VALUE_TOO_LONG: 'P2000',
  /** Unique constraint violation. */
  UNIQUE_CONSTRAINT: 'P2002',
  /** Foreign key constraint violation. */
  FOREIGN_KEY_CONSTRAINT: 'P2003',
  /** Inconsistent column data, e.g. a malformed UUID. */
  INCONSISTENT_COLUMN_DATA: 'P2023',
  /** A record required by the operation was not found. */
  RECORD_NOT_FOUND: 'P2025',
} as const;

/**
 * Connection-level codes a running client reports as a
 * `PrismaClientKnownRequestError` once the database becomes unreachable after
 * start-up (a fresh client reports the same failures as a
 * `PrismaClientInitializationError`). Transient: mapped to 503.
 */
export const PRISMA_CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  /** Can't reach the database server. */
  'P1001',
  /** Reaching the database server timed out. */
  'P1002',
  /** Operations timed out. */
  'P1008',
  /** The server closed the connection. */
  'P1017',
  /** Timed out fetching a new connection from the connection pool. */
  'P2024',
]);

/** Union of every Prisma client error class the mapper understands. */
export type PrismaClientError =
  | Prisma.PrismaClientKnownRequestError
  | Prisma.PrismaClientValidationError
  | Prisma.PrismaClientUnknownRequestError
  | Prisma.PrismaClientRustPanicError
  | Prisma.PrismaClientInitializationError;

/** True for any error raised by the Prisma client. */
export function isPrismaClientError(error: unknown): error is PrismaClientError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientInitializationError
  );
}

/**
 * A Prisma failure translated into application terms. It is a plain `Error`
 * (not an `HttpException`) so BullMQ workers, schedulers and scripts can
 * throw, classify and log it without depending on HTTP types; the HTTP layer
 * reads {@link status} and {@link code} to build the problem details body.
 *
 * `message` is always client-safe: it never contains the raw Prisma message,
 * SQL, column values or stack. The original error is kept on `cause` for
 * server-side logging only.
 */
export class PrismaMappedError extends Error {
  override readonly name = 'PrismaMappedError';

  constructor(
    /** Application error code serialised into the response envelope. */
    readonly code: ErrorCode,
    /** Client-safe description of the failure. */
    message: string,
    /** Prisma's own error code (e.g. `P2002`), when the error carried one. */
    readonly prismaCode: string | undefined,
    /**
     * Fields involved in a unique-constraint conflict, when derivable. For
     * server-side logs only; never part of a client response.
     */
    readonly fields: string[] | undefined,
    /** The original Prisma error. Never serialise this to a client. */
    override readonly cause: unknown,
  ) {
    super(message);
  }

  /** HTTP-equivalent status for the mapped code (e.g. 409 for CONFLICT, 503 for DATABASE_UNAVAILABLE). */
  get status(): number {
    return ERROR_STATUS[this.code] ?? 500;
  }

  /**
   * True when retrying the same operation cannot succeed (constraint
   * violations, missing rows, invalid queries). Workers use this to fail a
   * job permanently instead of burning retries.
   */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** Structured, secret-free summary for log records. */
  toLogContext(): Record<string, unknown> {
    return {
      code: this.code,
      status: this.status,
      prismaCode: this.prismaCode,
      ...(this.fields ? { fields: this.fields } : {}),
    };
  }
}

/**
 * Field names from a P2002 `meta.target`. Prisma reports an array of model
 * field names; a bare string is a database constraint name, which would
 * expose schema internals, so it is ignored.
 */
function uniqueTargetFields(meta: Record<string, unknown> | undefined): string[] | undefined {
  const target = meta?.target;
  if (!Array.isArray(target)) return undefined;
  const fields = target.filter((field): field is string => typeof field === 'string' && field.length > 0);
  return fields.length > 0 ? fields : undefined;
}

/** Client-safe messages. They never echo the Prisma message, SQL, `meta`, constraint or model names. */
export const PRISMA_ERROR_MESSAGES = {
  UNIQUE_CONSTRAINT: 'A resource with these details already exists',
  RECORD_NOT_FOUND: 'Resource not found',
  FOREIGN_KEY_CONSTRAINT:
    'The operation conflicts with a related resource that does not exist or is still in use',
  VALUE_TOO_LONG: 'A provided value is too long',
  INCONSISTENT_COLUMN_DATA: 'A provided value has an invalid format',
  INVALID_QUERY: 'Invalid database query or input data',
  UNAVAILABLE: 'The database is temporarily unavailable; please retry later',
  UNEXPECTED: 'An unexpected database error occurred',
} as const;

/**
 * Maps a Prisma client error onto a typed {@link PrismaMappedError} by class
 * (`instanceof`) and error `code` — never by parsing message text:
 *
 * | Prisma error                                 | Code                   | Status |
 * | -------------------------------------------- | ---------------------- | ------ |
 * | `P2002` unique constraint                    | `CONFLICT`             | 409    |
 * | `P2025` record not found                     | `NOT_FOUND`            | 404    |
 * | `P2003` foreign key constraint               | `CONFLICT`             | 409    |
 * | `P2000` value too long                       | `BAD_REQUEST`          | 400    |
 * | `P2023` inconsistent column data             | `BAD_REQUEST`          | 400    |
 * | `P1001` `P1002` `P1008` `P1017` `P2024`      | `DATABASE_UNAVAILABLE` | 503    |
 * | any other known request error code           | `INTERNAL_ERROR`       | 500    |
 * | `PrismaClientValidationError`                | `BAD_REQUEST`          | 400    |
 * | `PrismaClientInitializationError`            | `DATABASE_UNAVAILABLE` | 503    |
 * | `PrismaClientRustPanicError`                 | `DATABASE_UNAVAILABLE` | 503    |
 * | `PrismaClientUnknownRequestError`            | `INTERNAL_ERROR`       | 500    |
 *
 * Messages come from {@link PRISMA_ERROR_MESSAGES} only. Returns `undefined`
 * for anything that is not a Prisma client error so callers can fall through
 * to their own handling.
 */
export function mapPrismaError(error: unknown): PrismaMappedError | undefined {
  if (!isPrismaClientError(error)) return undefined;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = (code: ErrorCode, message: string, fields?: string[]) =>
      new PrismaMappedError(code, message, error.code, fields, error);
    switch (error.code) {
      case PRISMA_ERROR_CODES.UNIQUE_CONSTRAINT:
        return mapped(ErrorCode.CONFLICT, PRISMA_ERROR_MESSAGES.UNIQUE_CONSTRAINT, uniqueTargetFields(error.meta));
      case PRISMA_ERROR_CODES.RECORD_NOT_FOUND:
        return mapped(ErrorCode.NOT_FOUND, PRISMA_ERROR_MESSAGES.RECORD_NOT_FOUND);
      case PRISMA_ERROR_CODES.FOREIGN_KEY_CONSTRAINT:
        return mapped(ErrorCode.CONFLICT, PRISMA_ERROR_MESSAGES.FOREIGN_KEY_CONSTRAINT);
      case PRISMA_ERROR_CODES.VALUE_TOO_LONG:
        return mapped(ErrorCode.BAD_REQUEST, PRISMA_ERROR_MESSAGES.VALUE_TOO_LONG);
      case PRISMA_ERROR_CODES.INCONSISTENT_COLUMN_DATA:
        return mapped(ErrorCode.BAD_REQUEST, PRISMA_ERROR_MESSAGES.INCONSISTENT_COLUMN_DATA);
      default:
        // A running client that loses the database reports connection
        // failures with these codes; they get the same 503 as an
        // initialisation error so clients back off instead of failing hard.
        if (PRISMA_CONNECTION_ERROR_CODES.has(error.code)) {
          return mapped(ErrorCode.DATABASE_UNAVAILABLE, PRISMA_ERROR_MESSAGES.UNAVAILABLE);
        }
        return mapped(ErrorCode.INTERNAL_ERROR, PRISMA_ERROR_MESSAGES.UNEXPECTED);
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return new PrismaMappedError(ErrorCode.BAD_REQUEST, PRISMA_ERROR_MESSAGES.INVALID_QUERY, undefined, undefined, error);
  }

  // Connection / engine start-up failures and engine panics: clients and load
  // balancers should back off and retry rather than treat this as a bug.
  if (
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    return new PrismaMappedError(
      ErrorCode.DATABASE_UNAVAILABLE,
      PRISMA_ERROR_MESSAGES.UNAVAILABLE,
      error instanceof Prisma.PrismaClientInitializationError ? error.errorCode : undefined,
      undefined,
      error,
    );
  }

  return new PrismaMappedError(ErrorCode.INTERNAL_ERROR, PRISMA_ERROR_MESSAGES.UNEXPECTED, undefined, undefined, error);
}
