import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiExtraModels,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';

export interface ApiModuleEndpointOptions {
  tag: 'transactions' | 'budgets' | 'agents' | 'webhooks' | string;
  summary: string;
  description?: string;
  model?: Type<unknown>;
  isArray?: boolean;
}

export function ApiModuleEndpointDocs(options: ApiModuleEndpointOptions) {
  const decorators: Array<ClassDecorator | MethodDecorator | PropertyDecorator> = [
    ApiTags(options.tag),
    ApiBearerAuth(),
    ApiOperation({
      summary: options.summary,
      description: options.description ?? options.summary,
    }),
    ApiBadRequestResponse({
      description: 'Validation failed or malformed request parameters',
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string', example: 'Invalid request payload' },
            },
          },
        },
      },
    }),
    ApiUnauthorizedResponse({
      description: 'Missing or invalid authentication credentials',
    }),
    ApiNotFoundResponse({
      description: 'Requested domain resource was not found',
    }),
    ApiInternalServerErrorResponse({
      description: 'Unexpected internal server error',
    }),
  ];

  if (options.model) {
    decorators.push(
      ApiExtraModels(options.model),
      ApiOkResponse({
        description: options.summary,
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: options.isArray
              ? { type: 'array', items: { $ref: getSchemaPath(options.model) } }
              : { $ref: getSchemaPath(options.model) },
          },
        },
      }),
    );
  } else {
    decorators.push(
      ApiOkResponse({
        description: options.summary,
        schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'object' },
          },
        },
      }),
    );
  }

  return applyDecorators(...decorators);
}
