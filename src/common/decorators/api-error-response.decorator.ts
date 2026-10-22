import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

/** Shared error envelope produced by the global exception filter. */
export function ApiErrorResponses(...statuses: number[]) {
  return applyDecorators(...statuses.map((status) => ApiResponse({
    status,
    description: status === 400 ? 'Invalid request' : status === 401 ? 'Authentication required' : status === 403 ? 'Forbidden' : status === 404 ? 'Resource not found' : status === 409 ? 'Conflict' : status === 422 ? 'Unprocessable request' : status === 429 ? 'Rate limit exceeded' : 'Request failed',
    schema: {
      type: 'object',
      required: ['success', 'error', 'requestId'],
      properties: {
        success: { type: 'boolean', enum: [false], example: false },
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', example: 'VALIDATION_ERROR' },
            message: { type: 'string', example: 'Invalid request' },
            details: { type: 'object', additionalProperties: true },
          },
        },
        requestId: { type: 'string', example: 'req_018f...' },
      },
    },
  })));
}
