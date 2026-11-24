import { Type } from '@nestjs/common';
import { ApiEnvelope, ApiEnvelopeDto } from './api-envelope.decorator';

export { ApiEnvelopeDto };

/**
 * Standardized OpenAPI response decorator wrapping a DTO model inside the
 * uniform Astroid response envelope `{ success, data, meta, requestId }`.
 */
export function ApiStandardResponse<TModel extends Type<unknown>>(
  model: TModel,
  options: { isArray?: boolean } = {},
) {
  return ApiEnvelope(model, options);
}
