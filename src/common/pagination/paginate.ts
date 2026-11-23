import { Paginated, PaginationMeta } from '../interfaces/api-response.interface';
import { CursorRow, encodeCursor } from './cursor';
import { PaginationQuery } from './pagination.query';

/** A page of rows plus its response meta. */
export interface CursorPage<T> {
  items: T[];
  meta: PaginationMeta;
}

/**
 * Turns the raw rows returned by a repository (fetched with `limit + 1`) into
 * the public page. `nextCursor` is always present — it is `null` on the final
 * page. The legacy offset fields (`page`, `totalPages`, `hasNext`, `hasPrev`)
 * are preserved so existing clients that read them keep working; `page` is
 * reported as 1 because cursor pages are position-based, not numbered.
 */
export function buildCursorPage<T extends CursorRow>(
  rows: T[],
  total: number,
  query: PaginationQuery,
): CursorPage<T> {
  const { limit } = query;
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasNext && last ? encodeCursor(last) : null;
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

  return {
    items,
    meta: {
      page: 1,
      limit,
      total,
      totalPages,
      hasNext,
      hasPrev: Boolean(query.cursor),
      nextCursor,
    },
  };
}

/** Convenience wrapper so services can return the response envelope directly. */
export function paginatePage<T extends CursorRow>(
  rows: T[],
  total: number,
  query: PaginationQuery,
): Paginated<T> {
  const { items, meta } = buildCursorPage(rows, total, query);
  return new Paginated(items, meta);
}
