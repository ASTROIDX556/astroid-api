import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiProperty, ApiPropertyOptional, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/**
 * OpenAPI model of the RFC 9457 problem-details body every failing request
 * returns (`application/problem+json`). The shape is identical for every
 * error, so it is declared once and referenced by the error responses.
 */
export class ApiErrorEnvelopeDto {
  @ApiProperty({
    example: 'urn:astroid:problem:not-found',
    description: 'URI identifying the problem type',
  })
  type!: string;

  @ApiProperty({ example: 'Not found', description: 'Short summary of the problem type' })
  title!: string;

  @ApiProperty({ example: 404, description: 'HTTP status code of this occurrence' })
  status!: number;

  @ApiProperty({ example: "Agent '018f0a1b' not found", description: 'Explanation of this occurrence' })
  detail!: string;

  @ApiProperty({ example: '/api/v1/agents/018f0a1b', description: 'Path of the request that produced the problem' })
  instance!: string;

  @ApiProperty({
    example: 'NOT_FOUND',
    description: 'Machine-readable error code — clients switch on this, not on the message',
  })
  code!: string;

  @ApiProperty({ example: 'req_018f...', description: 'Correlation id, also sent as the x-request-id header' })
  requestId!: string;

  @ApiPropertyOptional({
    description: 'Structured context, e.g. the field-level validation errors',
  })
  details?: unknown;
}

/**
 * A documented error status. `true` uses the default description, a string
 * overrides it.
 */
export type ApiErrorStatus = boolean | string;

/** The error status codes an endpoint can answer with. */
export interface ApiErrorResponsesOptions {
  /** 400 — the request body or query failed validation. */
  validation?: ApiErrorStatus;
  /** 401 — the request is not authenticated. */
  unauthorized?: ApiErrorStatus;
  /** 403 — the principal lacks the required role or scope. */
  forbidden?: ApiErrorStatus;
  /** 404 — the addressed resource does not exist. */
  notFound?: ApiErrorStatus;
  /** 409 — the request conflicts with the current state. */
  conflict?: ApiErrorStatus;
  /** 422 — the request is well formed but violates a policy. */
  unprocessable?: ApiErrorStatus;
  /** 429 — the caller exceeded its rate limit. */
  tooManyRequests?: ApiErrorStatus;
  /** 500 — the request failed because of an unexpected server error. */
  serverError?: ApiErrorStatus;
}

/** Default descriptions of the standard error responses. */
const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Validation error',
  401: 'Not authenticated',
  403: 'Insufficient permissions',
  404: 'Resource not found',
  409: 'Conflict with the current state',
  422: 'Request rejected by a policy',
  429: 'Rate limit exceeded',
  500: 'Unexpected server error',
};

/** Status code of every documented error, in the order they are emitted. */
const ERROR_STATUSES: Array<[keyof ApiErrorResponsesOptions, number]> = [
  ['validation', 400],
  ['unauthorized', 401],
  ['forbidden', 403],
  ['notFound', 404],
  ['conflict', 409],
  ['unprocessable', 422],
  ['tooManyRequests', 429],
  ['serverError', 500],
];

/**
 * Documents the error responses of an endpoint.
 *
 * Every error the API returns uses the same RFC 9457 body, so the responses
 * reference {@link ApiErrorEnvelopeDto} instead of repeating the schema. Only
 * the status codes that can actually occur should be requested; pass a string
 * instead of `true` to document a more specific description.
 *
 * The decorator replaces any plain `@ApiResponse` for the same status, so the
 * two must not be combined.
 */
export function ApiErrorResponses(options: ApiErrorResponsesOptions) {
  const responses = ERROR_STATUSES.filter(([key]) => options[key] !== undefined && options[key] !== false).map(
    ([key, status]) => {
      const configured = options[key];
      const description =
        typeof configured === 'string' ? configured : ERROR_DESCRIPTIONS[status];
      return ApiResponse({
        status,
        description,
        content: {
          'application/problem+json': {
            schema: { $ref: getSchemaPath(ApiErrorEnvelopeDto) },
          },
        },
      });
    },
  );

  return applyDecorators(ApiExtraModels(ApiErrorEnvelopeDto), ...responses);
}
