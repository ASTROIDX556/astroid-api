import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { TOTAL_COUNT_HEADER } from '../constants/headers';

/** Generic OpenAPI model describing the success envelope for a given data type. */
export class ApiEnvelopeDto {
  @ApiProperty({ example: true, description: 'Always true — the request succeeded' })
  success!: boolean;

  @ApiProperty({ description: 'The response payload — shape varies by endpoint' })
  data!: unknown;

  @ApiProperty({ example: {}, description: 'Pagination and other request metadata' })
  meta!: Record<string, unknown>;

  @ApiProperty({ example: 'req_018f...', description: 'Correlation id, also sent as the x-request-id header' })
  requestId!: string;
}

/** Cursor pagination fields placed in the shared response envelope's `meta`. */
export class CursorPaginationMetaDto {
  @ApiProperty({ example: 20, description: 'Page size (maximum number of items returned).' }) limit!: number;
  @ApiProperty({ example: true, description: 'Whether another page is available.' }) hasMore!: boolean;
  @ApiPropertyOptional({ example: 'eyJ2IjoxLCJjcmVhdGVkQXQiOiIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6ImFiYyJ9', nullable: true, type: String, description: 'Opaque cursor for the next page, or null when there are no more results.' }) nextCursor!: string | null;
}

/** Page pagination fields placed in the shared response envelope's `meta`. */
export class PaginationMetaDto {
  @ApiProperty({ example: 1, description: '1-based page number.' }) page!: number;
  @ApiProperty({ example: 20, description: 'Number of items per page.' }) pageSize!: number;
  @ApiProperty({ example: 120, description: 'Total number of matching items.' }) total!: number;
  @ApiProperty({ example: 6, description: 'Number of pages available.' }) totalPages!: number;
  @ApiProperty({ example: true, description: 'Whether a following page is available.' }) hasNextPage!: boolean;
  @ApiProperty({ example: false, description: 'Whether a preceding page is available.' }) hasPreviousPage!: boolean;
}

/** Options for the {@link ApiEnvelope} decorator. */
export interface ApiEnvelopeOptions {
  /** Document the payload as an array of `model`. */
  isArray?: boolean;
  /** HTTP status of the success response (defaults to 200). */
  status?: number;
  /** Description of the success response. */
  description?: string;
  /** Response headers to document (e.g. the pagination total count). */
  headers?: Record<string, { description: string; schema: { type: string } }>;
}

/**
 * Documents an endpoint as returning `{ success, data: <model>, meta, requestId }`.
 * Pass `isArray` for list endpoints and `status` for endpoints that answer with
 * something other than 200 (e.g. 201 for creations).
 *
 * The decorator owns the success response entirely, so it must not be combined
 * with a plain `@ApiResponse` for the same status — the last decorator applied
 * wins and the envelope schema would be dropped.
 */
export function ApiEnvelope<TModel extends Type<unknown>>(
  model: TModel,
  options: ApiEnvelopeOptions = {},
) {
  const dataSchema = options.isArray
    ? { type: 'array', items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };

  return applyDecorators(
    ApiExtraModels(ApiEnvelopeDto, model),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description ?? 'Successful response',
      ...(options.headers ? { headers: options.headers } : {}),
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiEnvelopeDto) },
          { properties: { data: dataSchema } },
        ],
      },
    }),
  );
}

/**
 * Documents a paginated list endpoint: the success envelope carries an array of
 * `model` plus the `X-Total-Count` header with the total number of matching
 * rows.
 */
export function ApiPaginatedEnvelope<TModel extends Type<unknown>>(
  model: TModel,
  options: Omit<ApiEnvelopeOptions, 'isArray' | 'headers'> = {},
) {
  return applyDecorators(
    ApiExtraModels(ApiEnvelopeDto, PaginationMetaDto, model),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description ?? 'Paginated response',
      headers: {
        [TOTAL_COUNT_HEADER]: {
          description: 'Total number of matching rows',
          schema: { type: 'integer' },
        },
      },
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiEnvelopeDto) },
          {
            properties: {
              data: { type: 'array', items: { $ref: getSchemaPath(model) } },
              meta: { $ref: getSchemaPath(PaginationMetaDto) },
            },
          },
        ],
      },
    }),
  );
}

/** Documents list endpoints that accept both page and legacy cursor pagination. */
export function ApiPageOrCursorPaginatedEnvelope<TModel extends Type<unknown>>(
  model: TModel,
  options: Omit<ApiEnvelopeOptions, 'isArray'> = {},
) {
  return applyDecorators(
    ApiExtraModels(ApiEnvelopeDto, PaginationMetaDto, CursorPaginationMetaDto, model),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description ?? 'Paginated response',
      headers: options.headers
        ? { ...options.headers }
        : {
            [TOTAL_COUNT_HEADER]: {
              description: 'Total number of matching rows',
              schema: { type: 'integer' },
            },
          },
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiEnvelopeDto) },
          {
            properties: {
              data: { type: 'array', items: { $ref: getSchemaPath(model) } },
              meta: {
                oneOf: [
                  { $ref: getSchemaPath(PaginationMetaDto) },
                  { $ref: getSchemaPath(CursorPaginationMetaDto) },
                ],
              },
            },
          },
        ],
      },
    }),
  );
}

/** Documents a cursor-paginated list while preserving the standard envelope. */
export function ApiCursorPaginatedEnvelope<TModel extends Type<unknown>>(
  model: TModel,
  options: Omit<ApiEnvelopeOptions, 'isArray'> = {},
) {
  return applyDecorators(
    ApiExtraModels(ApiEnvelopeDto, CursorPaginationMetaDto, model),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description ?? 'Cursor-paginated response',
      schema: { allOf: [{ $ref: getSchemaPath(ApiEnvelopeDto) }, { properties: { data: { type: 'array', items: { $ref: getSchemaPath(model) } }, meta: { $ref: getSchemaPath(CursorPaginationMetaDto) } } }] },
    }),
  );
}
