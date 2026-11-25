import { BadRequestException } from '@nestjs/common';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_PAGE_NUMBER = 1;

export interface RepositoryPaginationInput {
  page?: number | string;
  limit?: number | string;
}

export interface NormalizedRepositoryPagination {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

export function enforceRepositoryPaginationLimits(
  input: RepositoryPaginationInput = {},
): NormalizedRepositoryPagination {
  const rawPage =
    input.page === undefined || input.page === ''
      ? DEFAULT_PAGE_NUMBER
      : Number(input.page);
  const rawLimit =
    input.limit === undefined || input.limit === ''
      ? DEFAULT_PAGE_SIZE
      : Number(input.limit);

  if (!Number.isInteger(rawPage) || rawPage < 1) {
    throw new BadRequestException('Pagination parameter "page" must be an integer >= 1');
  }

  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    throw new BadRequestException('Pagination parameter "limit" must be an integer >= 1');
  }

  if (rawLimit > MAX_PAGE_SIZE) {
    throw new BadRequestException(
      `Pagination parameter "limit" cannot exceed MAX_PAGE_SIZE of ${MAX_PAGE_SIZE}`,
    );
  }

  return {
    page: rawPage,
    limit: rawLimit,
    skip: (rawPage - 1) * rawLimit,
    take: rawLimit,
  };
}
