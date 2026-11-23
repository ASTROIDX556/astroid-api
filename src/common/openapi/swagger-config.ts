import { DocumentBuilder } from '@nestjs/swagger';
import { OpenAPIObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * The OpenAPI document configuration served at `/docs` (see `main.ts`). Shared
 * with `npm run docs:check` (`src/openapi.spec.ts`) so the check validates the
 * exact document clients get: same metadata and same security schemes.
 */
export function buildSwaggerConfig(): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('Astroid API')
    .setDescription(
      'The intelligence layer for the Financial Operating System for autonomous AI agents on Stellar.',
    )
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'api-key')
    .build();
}
