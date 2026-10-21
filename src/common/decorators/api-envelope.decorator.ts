import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiResponse, getSchemaPath } from '@nestjs/swagger';
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
  return ApiEnvelope(model, {
    ...options,
    isArray: true,
    headers: {
      [TOTAL_COUNT_HEADER]: {
        description: 'Total number of matching rows',
        schema: { type: 'integer' },
      },
    },
  });
}
