import { z } from 'zod';
import { ErrorCode } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';

/**
 * The single ordering contract behind cursor pagination. Every migrated list
 * endpoint returns rows newest-first, ties broken by the (time-ordered UUIDv7)
 * primary key. The order signature is embedded in each cursor so that changing
 * it later invalidates existing cursors loudly (HTTP 400) instead of silently
 * returning wrong pages.
 */
export const CURSOR_ORDER = 'createdAt:id:desc';
export const CURSOR_VERSION = 1;

/** Encoded inside the opaque, URL-safe cursor string. */
const cursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  o: z.literal(CURSOR_ORDER),
  t: z.string().datetime(),
  id: z.string().min(1).max(128),
});

/** A decoded position in the feed. */
export interface CursorPosition {
  createdAt: Date;
  id: string;
}

/** The minimum row shape a cursor can be built from. */
export interface CursorRow {
  id: string;
  createdAt: Date;
}

/**
 * Builds the opaque cursor for a row. Deliberately base64url-encoded rather
 * than encrypted: cursors carry no secrets, only a position, and clients treat
 * them as opaque strings.
 */
export function encodeCursor(row: CursorRow): string {
  const payload = {
    v: CURSOR_VERSION,
    o: CURSOR_ORDER,
    t: row.createdAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a client-supplied cursor. Any malformed, truncated or tampered value
 * (including one produced under a different ordering) is rejected with a 400
 * INVALID_CURSOR — never a 500 and never an unbounded full-table scan.
 */
export function decodeCursor(cursor: string): CursorPosition {
  const invalid = (reason: string): never => {
    throw new DomainException(ErrorCode.INVALID_CURSOR, 'Invalid pagination cursor', {
      reason,
    });
  };

  if (cursor.length === 0 || cursor.length > 512) {
    return invalid('cursor length out of range');
  }

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return invalid('cursor is not valid base64url');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(decoded);
  } catch {
    return invalid('cursor payload is not JSON');
  }

  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return invalid('cursor payload does not match the pagination contract');
  }

  const createdAt = new Date(parsed.data.t);
  if (Number.isNaN(createdAt.getTime())) {
    return invalid('cursor timestamp is not a valid date');
  }

  return { createdAt, id: parsed.data.id };
}

/**
 * A Prisma-compatible compound predicate for keyset pagination. It is returned
 * under `AND` so it composes with a module's own filters (which may already use
 * `OR`) instead of overwriting them.
 *
 * Semantics: `createdAt < cursor.createdAt` OR
 *            (`createdAt = cursor.createdAt` AND `id < cursor.id`)
 */
export interface CursorWhereInput {
  AND?: Array<{
    OR?: Array<{
      createdAt?: { lt: Date } | Date;
      id?: { lt: string };
    }>;
  }>;
}

export function cursorWhere(cursor?: string | null): CursorWhereInput {
  if (!cursor) {
    return {};
  }
  const position = decodeCursor(cursor);
  return {
    AND: [
      {
        OR: [
          { createdAt: { lt: position.createdAt } },
          { createdAt: position.createdAt, id: { lt: position.id } },
        ],
      },
    ],
  };
}
