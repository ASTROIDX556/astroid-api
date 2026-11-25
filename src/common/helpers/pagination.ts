import { z } from 'zod';
import { PaginationMeta } from '../interfaces/api-response.interface';
import { isValidCursor } from '../pagination/cursor-pagination';

/** Page size applied when a list request omits `pageSize` and legacy `limit`. */
export const DEFAULT_PAGE_LIMIT = 20;

/** Hard upper bound on `limit`; larger values are rejected with 400. */
export const MAX_PAGE_LIMIT = 100;

/**
 * Standard query parameters supported by every list endpoint.
 *
 * Clients page either by `offset` (row offset, preferred) or by `page`
 * (1-based page number); supplying both is rejected. After parsing, both
 * `offset` and `page` are always populated so services and metadata builders
 * never need to care which one the client used. Negative, non-integer or
 * out-of-range values fail validation and surface as 400 Bad Request.
 */
export const paginationQuerySchema = z
  .object({
    offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    page: z.coerce.number().int().positive().max(1_000_000_000).optional(),
    pageSize: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).optional(),
    limit: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).optional(),
    cursor: z.string().max(256).refine(isValidCursor, 'Invalid cursor').optional(),
    sort: z.string().default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    search: z.string().optional(),
    filter: z.string().optional(),
  })
  .passthrough()
  .superRefine((query, ctx) => {
    if (query.offset !== undefined && query.page !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either offset or page, not both', path: ['offset'] });
    }
    if (query.pageSize !== undefined && query.limit !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either pageSize or limit, not both', path: ['pageSize'] });
    }
  })
  .transform((query) => {
    const limit = query.pageSize ?? query.limit ?? DEFAULT_PAGE_LIMIT;
    const page = query.page ?? (query.offset === undefined ? 1 : Math.floor(query.offset / limit) + 1);
    const offset = query.offset ?? (page - 1) * limit;
    if (!Number.isSafeInteger(offset) || offset > Number.MAX_SAFE_INTEGER) {
      throw new z.ZodError([{
        code: z.ZodIssueCode.custom,
        path: ['page'],
        message: 'Pagination offset exceeds the supported range',
      }]);
    }
    return { ...query, offset, page, pageSize: limit, limit };
  });

export type PaginationQuery = {
  offset: number;
  page: number;
  pageSize?: number;
  limit: number;
  sort: string;
  order: 'asc' | 'desc';
  search?: string;
  filter?: string;
};

export interface PrismaPagination {
  skip: number;
  take: number;
  orderBy: Record<string, 'asc' | 'desc'>;
}

/**
 * Translates validated pagination query params into Prisma arguments. The
 * bounds are passed as bound `skip`/`take` values (never interpolated into
 * SQL), and `sort` is restricted to an allow-list of columns.
 */
export function toPrismaPagination(
  query: Pick<PaginationQuery, 'offset' | 'limit' | 'sort' | 'order'>,
  allowedSortFields: string[],
): PrismaPagination {
  const fallback = allowedSortFields.includes('createdAt')
    ? 'createdAt'
    : (allowedSortFields[0] ?? 'createdAt');
  const sort = allowedSortFields.includes(query.sort) ? query.sort : fallback;
  return {
    skip: query.offset,
    take: query.limit,
    orderBy: { [sort]: query.order },
  };
}

/** Builds pagination metadata for the response envelope. */
export function buildPaginationMeta(
  total: number,
  query: { page?: number; pageSize?: number; limit?: number },
): PaginationMeta {
  const page = query.page ?? 1;
  const limit = query.pageSize ?? query.limit ?? DEFAULT_PAGE_LIMIT;
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    pageSize: limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
