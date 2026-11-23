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
  /** A record required by the operation was not found. */
  RECORD_NOT_FOUND: 'P2025',
} as const;

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
    /** Fields involved in a unique-constraint conflict, when derivable. */
    readonly fields: string[] | undefined,
    /** The original Prisma error. Never serialise this to a client. */
    override readonly cause: unknown,
  ) {
    super(message);
  }

  /** HTTP-equivalent status for the mapped code (e.g. 409 for CONFLICT). */
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

/**
 * Maps a Prisma client error onto a typed {@link PrismaMappedError} by error
 * code (never by parsing message text):
 *
 * | Prisma error                       | Code               | Status |
 * | ---------------------------------- | ------------------ | ------ |
 * | `P2002` unique constraint          | `CONFLICT`         | 409    |
 * | `P2025` record not found           | `NOT_FOUND`        | 404    |
 * | `P2003` foreign key constraint     | `BAD_REQUEST`      | 400    |
 * | `P2000` value too long             | `VALIDATION_ERROR` | 422    |
 * | `PrismaClientValidationError`      | `BAD_REQUEST`      | 400    |
 * | any other Prisma error             | `INTERNAL_ERROR`   | 500    |
 *
 * Returns `undefined` for anything that is not a Prisma client error so
 * callers can fall through to their own handling.
 */
export function mapPrismaError(error: unknown): PrismaMappedError | undefined {
  if (!isPrismaClientError(error)) return undefined;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case PRISMA_ERROR_CODES.UNIQUE_CONSTRAINT: {
        const fields = uniqueTargetFields(error.meta);
        const message = fields
          ? `A resource with this ${fields.join(', ')} already exists`
          : 'A resource with these unique attributes already exists';
        return new PrismaMappedError(ErrorCode.CONFLICT, message, error.code, fields, error);
      }
      case PRISMA_ERROR_CODES.RECORD_NOT_FOUND:
        return new PrismaMappedError(ErrorCode.NOT_FOUND, 'Resource not found', error.code, undefined, error);
      case PRISMA_ERROR_CODES.FOREIGN_KEY_CONSTRAINT:
        return new PrismaMappedError(
          ErrorCode.BAD_REQUEST,
          'Foreign key constraint failed: referenced resource does not exist or has dependent records',
          error.code,
          undefined,
          error,
        );
      case PRISMA_ERROR_CODES.VALUE_TOO_LONG:
        return new PrismaMappedError(
          ErrorCode.VALIDATION_ERROR,
          'Provided value exceeds maximum allowed length for field',
          error.code,
          undefined,
          error,
        );
      default:
        return new PrismaMappedError(
          ErrorCode.INTERNAL_ERROR,
          'An unexpected database error occurred',
          error.code,
          undefined,
          error,
        );
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return new PrismaMappedError(
      ErrorCode.BAD_REQUEST,
      'Invalid database query or input data',
      undefined,
      undefined,
      error,
    );
  }

  return new PrismaMappedError(
    ErrorCode.INTERNAL_ERROR,
    'An unexpected database error occurred',
    undefined,
    undefined,
    error,
  );
}
