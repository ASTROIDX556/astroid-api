import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, INestApplication, Post, RequestMethod } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  DocumentBuilder,
  SwaggerModule,
} from '@nestjs/swagger';
import { OpenAPIObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { Public } from '../decorators/public.decorator';
import {
  RegisteredRoute,
  findDanglingRefs,
  findDuplicateRoutes,
  findMissingDeclaredSchemas,
  findMissingRequestSchemas,
  findOperationsMissingSecurity,
  findOperationsWithUntypedRequestBody,
  findOperationsWithoutResponses,
  findOperationsWithoutSuccessSchema,
  findOperationsWithoutSummary,
  findStaleAllowlistEntries,
  findUndocumentedRoutes,
  findUnservedOperations,
  listRegisteredRoutes,
  routeHandlers,
  routeKey,
  toOpenApiPath,
} from './openapi-coverage';

/** A minimal document with the given paths and schemas. */
function doc(
  paths: OpenAPIObject['paths'],
  schemas: Record<string, object> = {},
): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1' },
    paths,
    components: {
      schemas,
      securitySchemes: { 'access-token': { type: 'http', scheme: 'bearer' } },
    },
  };
}

const ok = (schema: object = { type: 'object' }) => ({
  '200': { description: 'ok', content: { 'application/json': { schema } } },
});

const route = (
  method: string,
  path: string,
  isPublic = false,
  acceptsBody = false,
): RegisteredRoute => ({
  method,
  path,
  handler: `Fixture.${method.toLowerCase()}${path.replace(/\W+/g, '_')}`,
  isPublic,
  acceptsBody,
});

describe('OpenAPI coverage checks on deliberately broken fixtures', () => {
  it('converts Express path parameters to OpenAPI placeholders', () => {
    expect(toOpenApiPath('/api/v1/agents/:id/keys/:keyId')).toBe('/api/v1/agents/{id}/keys/{keyId}');
    expect(toOpenApiPath('/api/v1/health/')).toBe('/api/v1/health');
    expect(toOpenApiPath('/')).toBe('/');
  });

  it('names a registered route missing from the document by method and path', () => {
    const findings = findUndocumentedRoutes(
      [route('GET', '/api/v1/agents'), route('DELETE', '/api/v1/agents/{id}')],
      doc({ '/api/v1/agents': { get: { responses: ok() } } }),
    );

    expect(findings).toEqual([
      'DELETE /api/v1/agents/{id} (Fixture.delete_api_v1_agents_id_) is not in the OpenAPI document',
    ]);
  });

  it('treats the same path under another method as undocumented', () => {
    const findings = findUndocumentedRoutes(
      [route('POST', '/api/v1/agents')],
      doc({ '/api/v1/agents': { get: { responses: ok() } } }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^POST \/api\/v1\/agents /);
  });

  it('accepts an allowlisted route and flags an entry that no longer applies', () => {
    const routes = [route('GET', '/metrics'), route('GET', '/api/v1/agents')];
    const document = doc({ '/api/v1/agents': { get: { responses: ok() } } });
    const allowlist = [
      { method: 'GET', path: '/metrics', reason: 'scrape endpoint' },
      { method: 'GET', path: '/api/v1/agents', reason: 'stale: now documented' },
      { method: 'POST', path: '/api/v1/gone', reason: 'stale: route removed' },
      { method: 'GET', path: '/metrics', reason: ' ' },
    ];

    expect(findUndocumentedRoutes(routes, document, allowlist)).toEqual([]);
    expect(findStaleAllowlistEntries(routes, document, allowlist)).toEqual([
      'GET /api/v1/agents is allowlisted but is documented; remove the entry',
      'GET /metrics is allowlisted without a reason',
      'POST /api/v1/gone is allowlisted but no route serves it',
    ]);
  });

  it('names a documented operation that no route serves, such as a wrong prefix', () => {
    const findings = findUnservedOperations(
      [route('GET', '/health/live', true)],
      doc({ '/api/v1/health/live': { get: { responses: ok() } } }),
    );

    expect(findings).toEqual(['GET /api/v1/health/live is documented but no route serves it']);
  });

  it('names a method and path registered by two handlers', () => {
    const findings = findDuplicateRoutes([
      { ...route('GET', '/health/ready'), handler: 'HealthController.ready' },
      { ...route('GET', '/health/ready'), handler: 'HealthController.getReadiness' },
      route('GET', '/health/live'),
    ]);

    expect(findings).toEqual([
      'GET /health/ready is registered by HealthController.ready, HealthController.getReadiness',
    ]);
  });

  it('names an operation without a 2xx response or without a response schema', () => {
    const findings = findOperationsWithoutSuccessSchema(
      doc({
        '/api/v1/a': { get: { responses: { '404': { description: 'missing' } } } },
        '/api/v1/b': { post: { responses: { '201': { description: 'created, no body schema' } } } },
        '/api/v1/c': { get: { responses: ok() } },
      }),
    );

    expect(findings).toEqual([
      'GET /api/v1/a documents no 2xx response',
      'POST /api/v1/b (201) documents no response schema',
    ]);
  });

  it('names a request body without content, without a schema, or with an untyped schema', () => {
    const findings = findOperationsWithUntypedRequestBody(
      doc(
        {
          '/api/v1/a': {
            post: {
              requestBody: {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateA' } } },
              },
              responses: ok(),
            },
          },
          '/api/v1/b': {
            post: {
              requestBody: { content: { 'application/json': { schema: {} } } },
              responses: ok(),
            },
          },
          '/api/v1/c': {
            post: { requestBody: { content: {} }, responses: ok() },
          },
          '/api/v1/d': {
            get: { responses: ok() },
          },
        },
        { CreateA: { type: 'object' } },
      ),
    );

    expect(findings).toEqual([
      'POST /api/v1/b (application/json) documents an untyped request body schema',
      'POST /api/v1/c documents a request body without content',
    ]);
  });


  it('names the handler whose operation has no summary or no response', () => {
    const document = doc({
      '/api/v1/a': { get: { summary: 'Has a summary', responses: ok() } },
      '/api/v1/b': { get: { description: 'No summary', responses: ok() } },
      '/api/v1/c': { get: { summary: 'No responses', responses: {} } },
    });
    const handlers = new Map([
      ['GET /api/v1/b', 'BetaController.list'],
      ['GET /api/v1/c', 'GammaController.list'],
    ]);

    expect(findOperationsWithoutSummary(document, handlers)).toEqual([
      'GET /api/v1/b (BetaController.list) has no OpenAPI operation summary',
    ]);
    expect(findOperationsWithoutResponses(document, handlers)).toEqual([
      'GET /api/v1/c (GammaController.list) documents no response',
    ]);
  });

  it('names a body-accepting route whose operation has no named DTO schema', () => {
    const routes = [
      route('POST', '/api/v1/agents', false, true),
      route('POST', '/api/v1/webhooks/receive', true, true),
    ];
    const document = doc({ '/api/v1/agents': { post: { responses: ok() } } });

    expect(findMissingRequestSchemas(routes, document, [], routeHandlers(routes))).toEqual([
      'POST /api/v1/agents (Fixture.post_api_v1_agents) declares a request body with no DTO schema in components.schemas',
    ]);
    expect(
      findMissingRequestSchemas(routes, document, [
        { method: 'POST', path: '/api/v1/agents', reason: 'fixture' },
      ]),
    ).toEqual([]);
  });

  it('names the handler whose declared DTO schema is absent from the operation', () => {
    class CreateThingDto {}
    const handler = () => undefined;
    Reflect.defineMetadata(
      DECORATORS.API_PARAMETERS,
      [{ in: 'body', type: CreateThingDto }],
      handler,
    );
    const routes: RegisteredRoute[] = [
      {
        ...route('POST', '/api/v1/things'),
        acceptsBody: true,
        handlerFunction: handler,
      },
    ];
    const document = doc({ '/api/v1/things': { post: { responses: ok() } } });

    expect(findMissingDeclaredSchemas(routes, document, routeHandlers(routes))).toEqual([
      'POST /api/v1/things (Fixture.post_api_v1_things) declares #/components/schemas/CreateThingDto but it is missing from the operation',
    ]);
  });

  it('names an authenticated operation without a security scheme, or with an undefined one', () => {
    const findings = findOperationsMissingSecurity(
      [
        route('GET', '/api/v1/a'),
        route('GET', '/api/v1/b'),
        route('GET', '/api/v1/c'),
        route('GET', '/api/v1/public', true),
      ],
      doc({
        '/api/v1/a': { get: { responses: ok() } },
        '/api/v1/b': { get: { responses: ok(), security: [{ 'session-cookie': [] }] } },
        '/api/v1/c': { get: { responses: ok(), security: [{ 'access-token': [] }] } },
        '/api/v1/public': { get: { responses: ok() } },
      }),
    );

    expect(findings).toEqual([
      'GET /api/v1/a requires authentication but declares no security scheme',
      "GET /api/v1/b declares the undefined security scheme 'session-cookie'",
    ]);
  });

  it('names where a dangling $ref appears, in an operation or in a schema', () => {
    const findings = findDanglingRefs(
      doc(
        {
          '/api/v1/agents/{id}': {
            get: { responses: ok({ $ref: '#/components/schemas/AgentDto' }) },
          },
          '/api/v1/wallets': {
            post: {
              requestBody: { $ref: '#/components/requestBodies/CreateWallet' },
              responses: ok({ $ref: '#/components/schemas/WalletDto' }),
            },
          },
        },
        {
          WalletDto: { type: 'object', properties: { owner: { $ref: '#/components/schemas/OwnerDto' } } },
        },
      ),
    );

    expect(findings).toEqual([
      'GET /api/v1/agents/{id} references the missing schema #/components/schemas/AgentDto',
      'POST /api/v1/wallets references the missing component #/components/requestBodies/CreateWallet',
      'components.schemas.WalletDto references the missing schema #/components/schemas/OwnerDto',
    ]);
  });

  it('finds nothing to report on a complete document', () => {
    const routes = [route('GET', '/api/v1/a')];
    const document = doc(
      {
        '/api/v1/a': {
          get: {
            responses: ok({ $ref: '#/components/schemas/A' }),
            security: [{ 'access-token': [] }],
          },
        },
      },
      { A: { type: 'object' } },
    );

    expect(findUndocumentedRoutes(routes, document)).toEqual([]);
    expect(findUnservedOperations(routes, document)).toEqual([]);
    expect(findOperationsWithoutSuccessSchema(document)).toEqual([]);
    expect(findOperationsWithUntypedRequestBody(document)).toEqual([]);
    expect(findOperationsMissingSecurity(routes, document)).toEqual([]);
    expect(findDanglingRefs(document)).toEqual([]);
  });
});

@Controller('documented')
class DocumentedController {
  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'A documented, authenticated route' })
  @ApiOkResponse({ schema: { type: 'object' } })
  findOne() {
    return {};
  }

  @Get('live')
  @Public()
  @ApiOperation({ summary: 'A public route served outside the prefix' })
  @ApiOkResponse({ schema: { type: 'object' } })
  live() {
    return {};
  }
}

/** Stands in for a route a contributor added without documenting it. */
@Controller('scratch')
class ScratchController {
  @Post('undocumented')
  @ApiExcludeEndpoint()
  undocumented() {
    return {};
  }

  @Get('unsecured')
  @ApiOperation({ summary: 'Authenticated but missing @ApiBearerAuth' })
  @ApiOkResponse({ schema: { type: 'object' } })
  unsecured() {
    return {};
  }

  @Get(['twice', 'twice'])
  @ApiOperation({ summary: 'Registered twice by mistake' })
  @ApiOkResponse({ schema: { type: 'object' } })
  twice() {
    return {};
  }
}

describe('OpenAPI coverage against a live Nest application with a temporary undocumented route', () => {
  let app: INestApplication;
  let routes: RegisteredRoute[];
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      controllers: [DocumentedController, ScratchController],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1', {
      exclude: [{ path: 'documented/live', method: RequestMethod.GET }],
    });
    await app.init();

    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
        .build(),
    );
    routes = listRegisteredRoutes(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the routes from router metadata, with the prefix and its exclusions applied', () => {
    expect(routes.map(routeKey).sort()).toEqual([
      'GET /api/v1/documented/{id}',
      'GET /api/v1/scratch/twice',
      'GET /api/v1/scratch/twice',
      'GET /api/v1/scratch/unsecured',
      'GET /documented/live',
      'POST /api/v1/scratch/undocumented',
    ]);
    expect(routes.find((r) => r.path === '/documented/live')?.isPublic).toBe(true);
    expect(routes.find((r) => r.path === '/api/v1/documented/{id}')?.isPublic).toBe(false);
  });

  it('fails on the temporary undocumented route and names it', () => {
    expect(findUndocumentedRoutes(routes, document)).toEqual([
      'POST /api/v1/scratch/undocumented (ScratchController.undocumented) is not in the OpenAPI document',
    ]);
  });

  it('passes once that route is allowlisted with a reason', () => {
    const allowlist = [
      { method: 'POST', path: '/api/v1/scratch/undocumented', reason: 'fixture' },
    ];
    expect(findUndocumentedRoutes(routes, document, allowlist)).toEqual([]);
    expect(findStaleAllowlistEntries(routes, document, allowlist)).toEqual([]);
  });

  it('names the authenticated route that declares no security scheme', () => {
    expect(findOperationsMissingSecurity(routes, document)).toEqual([
      'GET /api/v1/scratch/twice requires authentication but declares no security scheme',
      'GET /api/v1/scratch/unsecured requires authentication but declares no security scheme',
    ]);
  });

  it('names the route registered twice', () => {
    expect(findDuplicateRoutes(routes)).toEqual([
      'GET /api/v1/scratch/twice is registered by ScratchController.twice, ScratchController.twice',
    ]);
  });

  it('finds every documented operation served, prefix exclusion included', () => {
    expect(findUnservedOperations(routes, document)).toEqual([]);
  });
});
