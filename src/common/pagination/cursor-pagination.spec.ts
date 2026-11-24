import { describe, expect, it } from 'vitest';
import { cursorPaginationQuerySchema, decodeCursor, encodeCursor, isValidCursor } from './cursor-pagination';

describe('cursor pagination', () => {
  it('round-trips an opaque timestamp and id tuple', () => {
    const cursor = encodeCursor({ createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 'row-1' });
    expect(cursor).not.toContain('row-1');
    expect(decodeCursor(cursor)).toEqual({ createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 'row-1' });
  });
  it.each(['bad', '', Buffer.from('{"v":2}').toString('base64url')])('rejects malformed cursors', (value) => {
    expect(isValidCursor(value)).toBe(false);
    expect(cursorPaginationQuerySchema.safeParse({ cursor: value }).success).toBe(false);
  });
  it('defaults and caps page size', () => {
    expect(cursorPaginationQuerySchema.parse({}).limit).toBe(20);
    expect(cursorPaginationQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
