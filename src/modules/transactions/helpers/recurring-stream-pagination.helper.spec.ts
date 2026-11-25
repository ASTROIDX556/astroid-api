import { describe, expect, it } from 'vitest';
import { paginateRecurringStreams } from './recurring-stream-pagination.helper';

describe('paginateRecurringStreams (#299)', () => {
  it('paginates recurring stream lists and reports hasNextPage accurately', () => {
    const streams = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    const page1 = paginateRecurringStreams(streams, 1, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.hasNextPage).toBe(true);

    const page2 = paginateRecurringStreams(streams, 2, 2);
    expect(page2.items).toEqual([{ id: 's3' }]);
    expect(page2.hasNextPage).toBe(false);
  });
});
