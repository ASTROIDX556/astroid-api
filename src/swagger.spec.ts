import { describe, expect, it } from 'vitest';
import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiOperation, ApiTags, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ApiEnvelope } from './common/decorators/api-envelope.decorator';

class MockDto {
  id!: string;
  name!: string;
}

/**
 * Minimal controller used to verify Swagger decorator composition.
 * Avoids the full AppModule which requires DATABASE_URL, Redis, etc.
 */
@ApiTags('test')
@ApiBearerAuth('access-token')
@Controller('test')
class TestController {
  @Get()
  @ApiOperation({ summary: 'List items' })
  @ApiEnvelope(MockDto, { isArray: true })
  @ApiResponse({ status: 200, description: 'Paginated list' })
  list() {
    return { items: [], meta: {} };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an item' })
  @ApiEnvelope(MockDto)
  @ApiResponse({ status: 200, description: 'Item details' })
  findOne() {
    return { id: '1' };
  }
}

@ApiTags('test2')
@Controller('test2')
class TestControllerNoEnvelope {
  @Get()
  @ApiOperation({ summary: 'Simple list' })
  @ApiResponse({ status: 200, description: 'List' })
  list() {
    return [];
  }
}

@Module({
  controllers: [TestController, TestControllerNoEnvelope],
})
class TestModule {}

describe('Swagger / OpenAPI document generation', () => {
  it('generates a valid OpenAPI document without runtime errors', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    const app = moduleRef.createNestApplication();

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Astroid API')
      .setDescription('Test document')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    expect(document).toBeDefined();
    expect(document.openapi).toMatch(/^3\.0\./);
    expect(document.info.title).toBe('Astroid API');
    expect(document.info.version).toBe('1.0');
    expect(document.paths).toBeDefined();

    await app.close();
  });

  it('documents the standard response envelope in endpoints that use @ApiEnvelope', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    const app = moduleRef.createNestApplication();

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Astroid API')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    // The GET /test endpoint should document the envelope schema
    const testGet = document.paths?.['/test']?.get;
    expect(testGet).toBeDefined();

    // Verify the response has a schema (the envelope)
    const okResponse = testGet!.responses?.['200'] as unknown as Record<string, unknown>;
    expect(okResponse).toBeDefined();
    const content = okResponse.content as Record<string, Record<string, unknown>> | undefined;
    expect(content?.['application/json']?.schema).toBeDefined();

    await app.close();
  });

  it('includes Bearer auth security scheme', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    const app = moduleRef.createNestApplication();

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Astroid API')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    expect(document.components?.securitySchemes).toBeDefined();
    expect(document.components?.securitySchemes).toHaveProperty('access-token');

    await app.close();
  });

  it('handles endpoints without @ApiEnvelope gracefully', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    const app = moduleRef.createNestApplication();

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Astroid API')
      .setVersion('1.0')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    // The GET /test2 endpoint (no envelope) should still work
    const test2Get = document.paths?.['/test2']?.get;
    expect(test2Get).toBeDefined();

    await app.close();
  });

  it('documents ApiEnvelopeDto properties in the schema', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    const app = moduleRef.createNestApplication();

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Astroid API')
      .setVersion('1.0')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    // ApiEnvelopeDto should be in the components/schemas
    const schemas = document.components?.schemas;
    expect(schemas).toBeDefined();
    expect(schemas).toHaveProperty('ApiEnvelopeDto');

    const envelopeSchema = schemas!['ApiEnvelopeDto'] as Record<string, unknown>;
    const properties = envelopeSchema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('success');
    expect(properties).toHaveProperty('data');
    expect(properties).toHaveProperty('meta');
    expect(properties).toHaveProperty('requestId');

    await app.close();
  });
});
