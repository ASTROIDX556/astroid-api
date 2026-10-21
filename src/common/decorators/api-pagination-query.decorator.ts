import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../helpers/pagination';

/**
 * Documents the standard list query parameters parsed by
 * `paginationQuerySchema` (`offset`/`page`, `limit`, `sort`, `order`) and the
 * 400 returned for invalid bounds.
 *
 * The `X-Total-Count` response header is documented by the success response
 * itself (see `ApiEnvelope`), so this decorator never overwrites it.
 */
export function ApiPaginationQuery() {
  return applyDecorators(
    ApiQuery({
      name: 'offset',
      required: false,
      type: Number,
      description: 'Zero-based number of rows to skip (default: 0). Mutually exclusive with page.',
    }),
    ApiQuery({
      name: 'page',
      required: false,
      type: Number,
      description: '1-based page number, an alternative to offset (default: 1).',
    }),
    ApiQuery({
      name: 'limit',
      required: false,
      type: Number,
      description: `Items per page (default: ${DEFAULT_PAGE_LIMIT}, max: ${MAX_PAGE_LIMIT}).`,
    }),
    ApiQuery({ name: 'sort', required: false, type: String, description: 'Sort field (default: createdAt).' }),
    ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'], description: 'Sort direction (default: desc).' }),
  );
}
