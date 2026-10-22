import { describe, expect, it } from 'vitest';
import {
  buildSplitTransferPrismaCursorArgs,
  sliceSplitTransferCursorPage,
} from './split-transfer-pagination.helper';

describe('Split transfer cursor pagination helper (#306)', () => {
  it('builds Prisma take/cursor arguments with optional cursor backward compatibility', () => {
    expect(buildSplitTransferPrismaCursorArgs({})).toEqual({
      take: 26,
      limit: 25,
    });

    expect(
      buildSplitTransferPrismaCursorArgs({ limit: 10, cursor: 'tx_100' }),
    ).toEqual({
      take: 11,
      skip: 1,
      cursor: { id: 'tx_100' },
      limit: 10,
    });
  });

  it('slices records and populates nextCursor and hasMore accurately', () => {
    const rows = [{ id: 'tx_1' }, { id: 'tx_2' }, { id: 'tx_3' }];
    const page1 = sliceSplitTransferCursorPage(rows, 2);
    expect(page1).toEqual({
      items: [{ id: 'tx_1' }, { id: 'tx_2' }],
      nextCursor: 'tx_2',
      hasMore: true,
    });

    const finalPage = sliceSplitTransferCursorPage([{ id: 'tx_3' }], 2);
    expect(finalPage).toEqual({
      items: [{ id: 'tx_3' }],
      nextCursor: null,
      hasMore: false,
    });
  });
});
