import { z } from 'zod';

export interface CursorPayload { createdAt: Date; id: string }
interface EncodedCursor { v: 1; createdAt: string; id: string }

/** Stable, opaque cursor for newest-first `(createdAt, id)` keyset pagination. */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: payload.createdAt.toISOString(), id: payload.id } satisfies EncodedCursor)).toString('base64url');
}

export function decodeCursor(value: string): CursorPayload {
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error();
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error();
    const parsed = JSON.parse(decoded.toString('utf8')) as Partial<EncodedCursor>;
    const createdAt = typeof parsed.createdAt === 'string' ? new Date(parsed.createdAt) : undefined;
    if (parsed.v !== 1 || typeof parsed.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(parsed.id) || !createdAt || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) throw new Error();
    return { createdAt, id: parsed.id };
  } catch { throw new Error('Invalid cursor'); }
}
export function isValidCursor(value: string): boolean { try { decodeCursor(value); return true; } catch { return false; } }
export const cursorPaginationQuerySchema = z.object({
  cursor: z.string().max(256).refine(isValidCursor, 'Invalid cursor').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;
