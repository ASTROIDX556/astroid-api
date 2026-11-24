import { z } from 'zod';

export const splitTransferCursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
});

export type SplitTransferCursorQuery = z.infer<
  typeof splitTransferCursorQuerySchema
>;

export interface CursorPaginatedSplitTransfers<T extends { id: string }> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function buildSplitTransferPrismaCursorArgs(
  rawQuery: Partial<SplitTransferCursorQuery> = {},
): {
  take: number;
  skip?: number;
  cursor?: { id: string };
  limit: number;
} {
  const parsed = splitTransferCursorQuerySchema.parse(rawQuery);
  if (parsed.cursor) {
    return {
      take: parsed.limit + 1,
      skip: 1,
      cursor: { id: parsed.cursor },
      limit: parsed.limit,
    };
  }
  return {
    take: parsed.limit + 1,
    limit: parsed.limit,
  };
}

export function sliceSplitTransferCursorPage<T extends { id: string }>(
  records: T[],
  limit: number,
): CursorPaginatedSplitTransfers<T> {
  const hasMore = records.length > limit;
  const items = hasMore ? records.slice(0, limit) : records;
  const nextCursor =
    hasMore && items.length > 0 ? items[items.length - 1].id : null;

  return {
    items,
    nextCursor,
    hasMore,
  };
}
