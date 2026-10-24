import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

/** RFC 9457 problem details returned by AllExceptionsFilter. */
export function ApiErrorResponses(...statuses: number[]) {
  return applyDecorators(...statuses.map((status) => ApiResponse({
    status,
    description: status === 400 ? 'Invalid request' : status === 401 ? 'Authentication required' : status === 403 ? 'Forbidden' : status === 404 ? 'Resource not found' : status === 409 ? 'Conflict' : status === 422 ? 'Unprocessable request' : status === 429 ? 'Rate limit exceeded' : 'Request failed',
    content: {
      'application/problem+json': {
        schema: {
          type: 'object',
          required: ['type', 'title', 'status', 'detail', 'instance', 'code', 'requestId'],
          properties: {
            type: { type: 'string', example: 'about:blank' },
            title: { type: 'string', example: 'Bad Request' },
            status: { type: 'integer', example: status },
            detail: { type: 'string', example: 'Invalid request' },
            instance: { type: 'string', example: '/api/v1/agents' },
            code: { type: 'string', example: 'BAD_REQUEST' },
            requestId: { type: 'string', example: 'req_018f...' },
            details: { description: 'Optional validation or domain error details' },
          },
        },
      },
    },
  })));
}
