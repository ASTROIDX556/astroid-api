import { describe, expect, it } from 'vitest';
import {
  buildPaginationMeta,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  paginationQuerySchema,
  toPrismaPagination,
} from './pagination';

describe('paginationQuerySchema', () => {
  it('defaults to the first page with 20 items', () => {
    const query = paginationQuerySchema.parse({});

    expect(query).toMatchObject({ offset: 0, page: 1, pageSize: DEFAULT_PAGE_LIMIT, limit: 20 });
    expect(DEFAULT_PAGE_LIMIT).toBe(20);
  });

  it('coerces string query values into numbers', () => {
    const query = paginationQuerySchema.parse({ offset: '100', limit: '25' });

    expect(query).toMatchObject({ offset: 100, limit: 25, page: 5 });
  });

  it('accepts pageSize and preserves limit as a legacy alias', () => {
    expect(paginationQuerySchema.parse({ pageSize: '25' })).toMatchObject({
      page: 1,
      offset: 0,
      pageSize: 25,
      limit: 25,
    });
  });

  it('rejects pageSize and limit together', () => {
    expect(paginationQuerySchema.safeParse({ pageSize: 25, limit: 25 }).success).toBe(false);
  });

  it('derives the offset from a page number', () => {
    const query = paginationQuerySchema.parse({ page: '3', limit: '20' });

    expect(query).toMatchObject({ offset: 40, page: 3, limit: 20 });
  });

  it('accepts a limit equal to the 100 cap', () => {
    expect(MAX_PAGE_LIMIT).toBe(100);
    expect(paginationQuerySchema.parse({ limit: '100' }).limit).toBe(100);
  });

  it.each([
    ['a limit above the cap', { limit: '101' }],
    ['a zero limit', { limit: '0' }],
    ['a negative limit', { limit: '-5' }],
    ['a negative offset', { offset: '-1' }],
    ['a fractional offset', { offset: '1.5' }],
    ['a non-numeric limit', { limit: 'abc' }],
    ['a non-numeric offset', { offset: 'ten' }],
    ['a zero page', { page: '0' }],
  ])('rejects %s', (_label, input) => {
    expect(paginationQuerySchema.safeParse(input).success).toBe(false);
  });

  it('rejects offset and page supplied together', () => {
    const result = paginationQuerySchema.safeParse({ offset: '10', page: '2' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['offset'],
      message: 'Provide either offset or page, not both',
    });
  });
});

describe('toPrismaPagination', () => {
  it('maps offset and limit onto skip and take', () => {
    const query = paginationQuerySchema.parse({ offset: '120', limit: '40' });

    expect(toPrismaPagination(query, ['createdAt'])).toEqual({
      skip: 120,
      take: 40,
      orderBy: { createdAt: 'desc' },
    });
  });

  it('falls back to createdAt for a sort field outside the allow-list', () => {
    const query = paginationQuerySchema.parse({ sort: 'passwordHash; DROP TABLE users' });

    expect(toPrismaPagination(query, ['name', 'createdAt']).orderBy).toEqual({ createdAt: 'desc' });
  });

  it('keeps an allow-listed sort field and direction', () => {
    const query = paginationQuerySchema.parse({ sort: 'name', order: 'asc' });

    expect(toPrismaPagination(query, ['name', 'createdAt']).orderBy).toEqual({ name: 'asc' });
  });

  it('falls back to the first allowed field when createdAt is not sortable', () => {
    const query = paginationQuerySchema.parse({});

    expect(toPrismaPagination(query, ['occurredAt']).orderBy).toEqual({ occurredAt: 'desc' });
  });
});

describe('buildPaginationMeta', () => {
  it('reports the slice position and totals', () => {
    const meta = buildPaginationMeta(120, paginationQuerySchema.parse({ offset: '50', limit: '50' }));

    expect(meta).toEqual({
      page: 2,
      pageSize: 50,
      total: 120,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('has no next slice on the last page', () => {
    const meta = buildPaginationMeta(120, paginationQuerySchema.parse({ offset: '100', limit: '50' }));

    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPreviousPage).toBe(true);
  });

  it('computes hasNext/hasPrev from offsets that are not page-aligned', () => {
    const meta = buildPaginationMeta(60, paginationQuerySchema.parse({ offset: '5', limit: '50' }));

    expect(meta).toMatchObject({ page: 1, pageSize: 50, hasNextPage: true, hasPreviousPage: false });
  });

  it('handles an empty result set', () => {
    const meta = buildPaginationMeta(0, paginationQuerySchema.parse({}));

    expect(meta).toMatchObject({ total: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false });
  });
});
