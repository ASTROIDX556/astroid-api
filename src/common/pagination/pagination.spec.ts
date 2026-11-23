import { describe, expect, it } from 'vitest';
import {
  CURSOR_ORDER,
  buildCursorPage,
  cursorWhere,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
} from './index';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';

const row = (id: string, iso: string) => ({ id, createdAt: new Date(iso) });

describe('cursor pagination', () => {
  describe('encode/decode', () => {
    it('round-trips a row position', () => {
      const createdAt = new Date('2026-11-20T10:00:00.000Z');
      const cursor = encodeCursor({ id: 'row_1', createdAt });

      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(cursor)).toEqual({ id: 'row_1', createdAt });
    });

    it('is opaque: the ordering contract is embedded, not client-controlled', () => {
      const cursor = encodeCursor(row('row_1', '2026-11-20T10:00:00.000Z'));
      const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      expect(payload.o).toBe(CURSOR_ORDER);
      expect(payload.v).toBe(1);
    });

    it('rejects a non-base64/JSON cursor with a 400 domain error', () => {
      for (const cursor of ['%%%not-a-cursor', Buffer.from('hello').toString('base64url')]) {
        try {
          decodeCursor(cursor);
          throw new Error('expected decodeCursor to throw');
        } catch (error) {
          expect(error).toBeInstanceOf(DomainException);
          expect((error as DomainException).code).toBe(ErrorCode.INVALID_CURSOR);
          expect((error as DomainException).getStatus()).toBe(400);
        }
      }
    });

    it('rejects a tampered payload and a future ordering change', () => {
      const valid = JSON.parse(
        Buffer.from(encodeCursor(row('a', '2026-01-01T00:00:00.000Z')), 'base64url').toString(
          'utf8',
        ),
      );

      const tampered = Buffer.from(
        JSON.stringify({ ...valid, o: 'name:asc' }),
        'utf8',
      ).toString('base64url');
      const wrongVersion = Buffer.from(
        JSON.stringify({ ...valid, v: 2 }),
        'utf8',
      ).toString('base64url');
      const missingId = Buffer.from(
        JSON.stringify({ ...valid, id: '' }),
        'utf8',
      ).toString('base64url');

      for (const cursor of [tampered, wrongVersion, missingId]) {
        expect(() => decodeCursor(cursor)).toThrow(DomainException);
      }
    });
  });

  describe('cursorWhere', () => {
    it('returns an empty predicate on the first page', () => {
      expect(cursorWhere(undefined)).toEqual({});
      expect(cursorWhere(null)).toEqual({});
    });

    it('builds a compound keyset predicate that breaks ties on id', () => {
      const createdAt = new Date('2026-05-01T12:00:00.000Z');
      const where = cursorWhere(encodeCursor({ id: 'row_9', createdAt }));

      expect(where).toEqual({
        AND: [
          {
            OR: [
              { createdAt: { lt: createdAt } },
              { createdAt, id: { lt: 'row_9' } },
            ],
          },
        ],
      });
    });
  });

  describe('query schema', () => {
    it('defaults limit to 20 and coerces strings', () => {
      expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
      expect(paginationQuerySchema.parse({ limit: '35', cursor: 'abc' }).limit).toBe(35);
    });

    it('rejects a limit above 100 and clamps nothing silently', () => {
      expect(() => paginationQuerySchema.parse({ limit: '101' })).toThrow();
      expect(() => paginationQuerySchema.parse({ limit: '0' })).toThrow();
    });
  });

  describe('buildCursorPage', () => {
    it('reports nextCursor = null on the final page', () => {
      const rows = [row('a', '2026-01-03T00:00:00.000Z'), row('b', '2026-01-02T00:00:00.000Z')];
      const page = buildCursorPage(rows, 2, { limit: 2 });

      expect(page.items).toHaveLength(2);
      expect(page.meta.nextCursor).toBeNull();
      expect(page.meta.hasNext).toBe(false);
      expect(page.meta.hasPrev).toBe(false);
      expect(page.meta.total).toBe(2);
    });

    it('trims the look-ahead row and encodes the last visible row as the cursor', () => {
      const rows = [
        row('a', '2026-01-03T00:00:00.000Z'),
        row('b', '2026-01-02T00:00:00.000Z'),
        row('c', '2026-01-01T00:00:00.000Z'),
      ];
      const page = buildCursorPage(rows, 10, { limit: 2 });

      expect(page.items.map((item) => item.id)).toEqual(['a', 'b']);
      expect(page.meta.hasNext).toBe(true);
      expect(page.meta.nextCursor).toBe(encodeCursor(rows[1]));
      expect(decodeCursor(page.meta.nextCursor as string).id).toBe('b');
    });

    it('flags hasPrev when the request carried a cursor', () => {
      const page = buildCursorPage([row('a', '2026-01-01T00:00:00.000Z')], 5, {
        limit: 2,
        cursor: encodeCursor(row('z', '2026-01-02T00:00:00.000Z')),
      });
      expect(page.meta.hasPrev).toBe(true);
      expect(page.meta.nextCursor).toBeNull();
    });
  });

  it('walking pages with a mid-walk insert neither repeats nor skips rows', () => {
    // Newest-first feed. Row `new` is inserted between page 1 and page 2.
    const t = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
    const feed = [
      row('e', t(50).toISOString()),
      row('d', t(40).toISOString()),
      row('c', t(30).toISOString()),
      row('b', t(20).toISOString()),
      row('a', t(10).toISOString()),
    ];

    const apply = (rows: typeof feed, cursor?: string) => {
      const query = { limit: 2, cursor };
      const filtered = cursor
        ? rows.filter((r) => {
            const position = decodeCursor(cursor);
            return (
              r.createdAt < position.createdAt ||
              (r.createdAt.getTime() === position.createdAt.getTime() && r.id < position.id)
            );
          })
        : rows;
      return buildCursorPage(filtered.slice(0, query.limit + 1), rows.length, query);
    };

    const first = apply(feed);
    expect(first.items.map((r) => r.id)).toEqual(['e', 'd']);

    // A new row arrives at the head of the feed; it must not shift page 2.
    const afterInsert = [row('new', t(59).toISOString()), ...feed];
    const second = apply(afterInsert, first.meta.nextCursor as string);
    const third = apply(afterInsert, second.meta.nextCursor as string);

    const walked = [...first.items, ...second.items, ...third.items].map((r) => r.id);
    expect(walked).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(new Set(walked).size).toBe(walked.length);
    expect(third.meta.nextCursor).toBeNull();
  });
});
