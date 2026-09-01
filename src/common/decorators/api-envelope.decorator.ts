import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiProperty, getSchemaPath } from '@nestjs/swagger';

/** Generic OpenAPI model describing the success envelope for a given data type. */
export class ApiEnvelopeDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ description: 'The response payload — shape varies by endpoint' })
  data!: unknown;

  @ApiProperty({ example: {} })
  meta!: Record<string, unknown>;

  @ApiProperty({ example: 'req_018f...' })
  requestId!: string;
}

/**
 * Documents an endpoint as returning `{ success, data: <model>, meta, requestId }`.
 * Pass `isArray` for list endpoints.
 */
export function ApiEnvelope<TModel extends Type<unknown>>(
  model: TModel,
  options: { isArray?: boolean } = {},
) {
  const dataSchema = options.isArray
    ? { type: 'array', items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };

  return applyDecorators(
    ApiExtraModels(ApiEnvelopeDto, model),
    ApiOkResponse({
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiEnvelopeDto) },
          { properties: { data: dataSchema } },
        ],
      },
    }),
  );
}
