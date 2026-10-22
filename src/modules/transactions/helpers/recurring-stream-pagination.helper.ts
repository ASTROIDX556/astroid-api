export interface RecurringStreamPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasNextPage: boolean;
}

export function paginateRecurringStreams<T>(
  allStreams: readonly T[],
  page: number = 1,
  limit: number = 20,
): RecurringStreamPage<T> {
  const safePage = Math.max(1, Math.trunc(page));
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  const start = (safePage - 1) * safeLimit;
  const items = allStreams.slice(start, start + safeLimit);

  return {
    items,
    page: safePage,
    limit: safeLimit,
    total: allStreams.length,
    hasNextPage: start + safeLimit < allStreams.length,
  };
}
