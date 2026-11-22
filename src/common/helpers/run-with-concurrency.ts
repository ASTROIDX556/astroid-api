/**
 * Runs `worker` over every item with at most `concurrency` calls in flight.
 *
 * Rejections are propagated to the caller: a run that must survive individual
 * failures (wallet reconciliation) catches them inside `worker` and records the
 * failure, so one bad item never aborts the remaining items.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency));
  let next = 0;

  const runNext = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runNext()),
  );
}
