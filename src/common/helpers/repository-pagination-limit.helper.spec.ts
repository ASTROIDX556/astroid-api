import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  enforceRepositoryPaginationLimits,
} from './repository-pagination-limit.helper';

describe('enforceRepositoryPaginationLimits (#314)', () => {
  it('applies default page and limit when omitted', () => {
    expect(enforceRepositoryPaginationLimits()).toEqual({
      page: 1,
      limit: DEFAULT_PAGE_SIZE,
      skip: 0,
      take: DEFAULT_PAGE_SIZE,
    });
  });

  it('accepts limits up to MAX_PAGE_SIZE (100) and computes skip/take', () => {
    expect(enforceRepositoryPaginationLimits({ page: '3', limit: '100' })).toEqual({
      page: 3,
      limit: MAX_PAGE_SIZE,
      skip: 200,
      take: 100,
    });
  });

  it('throws 400 BadRequestException when limit exceeds MAX_PAGE_SIZE (100)', () => {
    expect(() =>
      enforceRepositoryPaginationLimits({ page: 1, limit: 101 }),
    ).toThrow(BadRequestException);
  });

  it('rejects non-positive or non-integer page and limit values', () => {
    expect(() => enforceRepositoryPaginationLimits({ page: 0 })).toThrow(
      BadRequestException,
    );
    expect(() => enforceRepositoryPaginationLimits({ limit: -5 })).toThrow(
      BadRequestException,
    );
  });
});
