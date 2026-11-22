import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
export function ApiCursorPaginationQuery() { return applyDecorators(
  ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque cursor returned by the previous page.' }),
  ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100).' }),
); }
