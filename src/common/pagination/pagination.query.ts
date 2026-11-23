import { z } from 'zod';

/** Items returned when the client does not ask for a specific page size. */
export const DEFAULT_PAGE_LIMIT = 20;
/** Hard ceiling so one client cannot request an unbounded scan. */
export const MAX_PAGE_LIMIT = 100;

/**
 * The shared paging contract for every list endpoint that returns a growing
 * collection: `limit` (coerced from the query string) and an opaque `cursor`.
 * A cursor is only ever produced by the server; clients echo it back verbatim.
 */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
  search: z.string().optional(),
  filter: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Arguments passed to a repository's `findManyAndCount` for a cursor page. */
export interface PrismaPagination {
  skip: number;
  take: number;
  orderBy: Record<string, 'asc' | 'desc'>;
}

/** The deterministic ordering every cursor-paginated endpoint uses. */
export const CURSOR_ORDER_BY: Record<string, 'asc' | 'desc'> = {
  createdAt: 'desc',
  id: 'desc',
};

/**
 * Translates the validated query into Prisma arguments. One extra row is
 * fetched so the helper can tell whether another page exists without a second
 * query.
 */
export function toPrismaPagination(query: PaginationQuery): PrismaPagination {
  return {
    skip: 0,
    take: query.limit + 1,
    orderBy: { ...CURSOR_ORDER_BY },
  };
}
