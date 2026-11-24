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
  findDuplicateEnvelopeComponents,
  findInlineErrorSchemas,
  findDuplicateRoutes,
  findMissingDeclaredSchemas,
  findMissingRequestSchemas,
  findOperationsMissingSecuritySchemes,
  findOperationsMissingStandardErrors,
  findOperationsWithUntypedRequestBody,
  findOperationsWithoutResponses,
  findOperationsWithoutSuccessEnvelope,
  findOperationsWithoutSuccessSchema,
  findRouteDocumentationGaps,
  findStaleAllowlistEntries,
  findStaleClientErrorExemptions,
  findUnservedOperations,
  RouteCheck,
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

/** A minimal documented operation that passes every per-route check. */
const complete = (extra: object = {}) => ({
  summary: 'Does a thing',
  tags: ['fixture'],
  responses: { ...ok(), '400': { description: 'bad request' } },
  security: [{ 'access-token': [] }],
  ...extra,
});

/** The messages of one kind of gap, as the docs:check tests assert them. */
function gapsOf(
  check: RouteCheck,
  routes: RegisteredRoute[],
  document: OpenAPIObject,
  options?: Parameters<typeof findRouteDocumentationGaps>[2],
): string[] {
  return findRouteDocumentationGaps(routes, document, options)
    .filter((gap) => gap.check === check)
    .map((gap) => gap.message);
}

describe('OpenAPI coverage checks on deliberately broken fixtures', () => {
  it('converts Express path parameters to OpenAPI placeholders', () => {
    expect(toOpenApiPath('/api/v1/agents/:id/keys/:keyId')).toBe('/api/v1/agents/{id}/keys/{keyId}');
    expect(toOpenApiPath('/api/v1/health/')).toBe('/api/v1/health');
    expect(toOpenApiPath('/')).toBe('/');
  });

  it('names a registered route whose path is missing from the document', () => {
    const routes = [route('GET', '/api/v1/agents'), route('DELETE', '/api/v1/agents/{id}')];
    const document = doc({ '/api/v1/agents': { get: complete() } });

    expect(gapsOf('path', routes, document)).toEqual([
      'Fixture.delete_api_v1_agents_id_ (DELETE /api/v1/agents/{id}): path /api/v1/agents/{id} is missing from the OpenAPI document',
    ]);
    expect(gapsOf('method', routes, document)).toEqual([]);
  });

  it('names a route whose path is documented under another method only', () => {
    const routes = [route('POST', '/api/v1/agents')];
    const document = doc({ '/api/v1/agents': { get: complete() } });

    expect(gapsOf('method', routes, document)).toEqual([
      'Fixture.post_api_v1_agents (POST /api/v1/agents): method POST is not documented on /api/v1/agents',
    ]);
    expect(gapsOf('path', routes, document)).toEqual([]);
    // No operation exists, so no further check reports the route.
    expect(findRouteDocumentationGaps(routes, document)).toHaveLength(1);
  });

  it('names an operation without a summary or without a tag', () => {
    const routes = [route('GET', '/api/v1/a'), route('GET', '/api/v1/b'), route('GET', '/api/v1/c')];
    const document = doc({
      '/api/v1/a': { get: complete({ summary: '  ' }) },
      '/api/v1/b': { get: complete({ tags: [] }) },
      '/api/v1/c': { get: complete({ tags: undefined, summary: undefined }) },
    });

    expect(gapsOf('summary', routes, document)).toEqual([
      'Fixture.get_api_v1_a (GET /api/v1/a): missing operation summary (@ApiOperation({ summary }))',
      'Fixture.get_api_v1_c (GET /api/v1/c): missing operation summary (@ApiOperation({ summary }))',
    ]);
    expect(gapsOf('tags', routes, document)).toEqual([
      'Fixture.get_api_v1_b (GET /api/v1/b): missing tag (@ApiTags)',
      'Fixture.get_api_v1_c (GET /api/v1/c): missing tag (@ApiTags)',
    ]);
  });

  it('requires a request body schema only where the handler takes a @Body()', () => {
    const routes = [
      route('POST', '/api/v1/agents', false, true),
      route('PATCH', '/api/v1/agents/{id}', false, true),
      route('DELETE', '/api/v1/agents/{id}', false, true),
      route('POST', '/api/v1/agents/{id}/pause'),
    ];
    const document = doc(
      {
        '/api/v1/agents': { post: complete() },
        '/api/v1/agents/{id}': {
          patch: complete({ requestBody: { content: { 'application/json': { schema: {} } } } }),
          delete: complete({
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/X' } } } },
          }),
        },
        '/api/v1/agents/{id}/pause': { post: complete() },
      },
      { X: { type: 'object' } },
    );

    expect(gapsOf('requestBody', routes, document)).toEqual([
      'Fixture.patch_api_v1_agents_id_ (PATCH /api/v1/agents/{id}): takes a @Body() but documents no request body schema',
      'Fixture.post_api_v1_agents (POST /api/v1/agents): takes a @Body() but documents no request body schema',
    ]);
  });

  it('requires a 4xx response, not just any error response, unless the route is exempt', () => {
    const routes = [
      route('GET', '/api/v1/a'),
      route('GET', '/api/v1/b'),
      route('GET', '/api/v1/c'),
      route('GET', '/health/live', true),
    ];
    const document = doc({
      '/api/v1/a': { get: complete({ responses: { ...ok(), '500': { description: 'boom' } } }) },
      '/api/v1/b': { get: complete({ responses: { ...ok(), '4XX': { description: 'client error' } } }) },
      '/api/v1/c': { get: complete({ responses: { ...ok(), '429': { description: 'slow down' } } }) },
      '/health/live': { get: complete({ responses: ok(), security: undefined }) },
    });
    const noClientErrorRoutes = [{ method: 'GET', path: '/health/live', reason: 'always 200' }];

    expect(gapsOf('clientError', routes, document)).toEqual([
      'Fixture.get_api_v1_a (GET /api/v1/a): missing 4xx error response',
      'Fixture.get_health_live (GET /health/live): missing 4xx error response',
    ]);
    expect(gapsOf('clientError', routes, document, { noClientErrorRoutes })).toEqual([
      'Fixture.get_api_v1_a (GET /api/v1/a): missing 4xx error response',
    ]);
  });

  it('flags a 4xx exemption that has no reason, no route, no operation, or is no longer needed', () => {
    const routes = [route('GET', '/health/live', true), route('GET', '/api/v1/a'), route('GET', '/metrics', true)];
    const document = doc({
      '/health/live': { get: complete({ responses: ok() }) },
      '/api/v1/a': { get: complete() },
    });

    expect(
      findStaleClientErrorExemptions(routes, document, [
        { method: 'GET', path: '/health/live', reason: 'always 200' },
        { method: 'GET', path: '/api/v1/a', reason: 'stale: now documents a 400' },
        { method: 'GET', path: '/metrics', reason: 'stale: not documented' },
        { method: 'GET', path: '/gone', reason: 'stale: route removed' },
        { method: 'GET', path: '/health/live', reason: '' },
      ]),
    ).toEqual([
      'GET /api/v1/a is exempt from the 4xx check but documents a 4xx; remove the entry',
      'GET /gone is exempt from the 4xx check but no route serves it',
      'GET /health/live is exempt from the 4xx check without a reason',
      'GET /metrics is exempt from the 4xx check but is not documented',
    ]);
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

    expect(gapsOf('path', routes, document, { allowlist })).toEqual([]);
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


  it('names the handler whose operation has no response', () => {
    const document = doc({
      '/api/v1/a': { get: { summary: 'Has a summary', responses: ok() } },
      '/api/v1/c': { get: { summary: 'No responses', responses: {} } },
    });
    const handlers = new Map([['GET /api/v1/c', 'GammaController.list']]);

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

  it('names a guarded operation without a security scheme, or with an undefined one', () => {
    const routes = [
      route('GET', '/api/v1/a'),
      route('GET', '/api/v1/b'),
      route('GET', '/api/v1/c'),
      route('GET', '/api/v1/public', true),
    ];
    const document = doc({
      '/api/v1/a': { get: complete({ security: undefined }) },
      '/api/v1/b': { get: complete({ security: [{ 'session-cookie': [] }] }) },
      '/api/v1/c': { get: complete() },
      '/api/v1/public': { get: complete({ security: undefined }) },
    });

    expect(gapsOf('security', routes, document)).toEqual([
      'Fixture.get_api_v1_a (GET /api/v1/a): is guarded but declares no security requirement (@ApiBearerAuth / @ApiSecurity)',
      "Fixture.get_api_v1_b (GET /api/v1/b): declares the undefined security scheme 'session-cookie'",
    ]);
  });

  it('accepts security inherited from the document for guarded routes', () => {
    const routes = [route('GET', '/api/v1/a')];
    const document: OpenAPIObject = {
      ...doc({ '/api/v1/a': { get: complete({ security: undefined }) } }),
      security: [{ 'access-token': [] }],
    };

    expect(gapsOf('security', routes, document)).toEqual([]);
  });

  it('names a @Public() route that declares a security requirement, directly or inherited', () => {
    const routes = [route('POST', '/api/v1/auth/login', true), route('GET', '/health/ready', true)];
    const document = doc({
      '/api/v1/auth/login': { post: complete() },
      '/health/ready': { get: complete({ security: undefined }) },
    });

    expect(gapsOf('publicSecurity', routes, document)).toEqual([
      "Fixture.post_api_v1_auth_login (POST /api/v1/auth/login): is @Public() but declares the security requirement 'access-token'",
    ]);
    expect(gapsOf('publicSecurity', routes, { ...document, security: [{ 'api-key': [] }] })).toEqual([
      "Fixture.get_health_ready (GET /health/ready): is @Public() but declares the security requirement 'api-key'",
      "Fixture.post_api_v1_auth_login (POST /api/v1/auth/login): is @Public() but declares the security requirement 'access-token'",
    ]);
    // An explicit empty override (`security: []`) opts a public route out of a document-wide requirement.
    expect(
      gapsOf('publicSecurity', [routes[1]], {
        ...doc({ '/health/ready': { get: complete({ security: [] }) } }),
        security: [{ 'api-key': [] }],
      }),
    ).toEqual([]);
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

  it('names a protected operation that omits one of the accepted credentials', () => {
    const findings = findOperationsMissingSecuritySchemes(
      [route('GET', '/api/v1/a'), route('GET', '/api/v1/public', true)],
      doc({
        '/api/v1/a': {
          get: { responses: ok(), security: [{ 'access-token': [] }] },
        },
        '/api/v1/public': { get: { responses: ok() } },
      }),
      ['access-token', 'api-key'],
    );

    expect(findings).toEqual(["GET /api/v1/a accepts 'api-key' but does not declare it as a security alternative"]);
  });

  it('accepts either credential when both are offered as alternatives', () => {
    const document = doc({
      '/api/v1/a': {
        get: { responses: ok(), security: [{ 'access-token': [] }, { 'api-key': [] }] },
      },
    });

    expect(
      findOperationsMissingSecuritySchemes([route('GET', '/api/v1/a')], document, ['access-token', 'api-key']),
    ).toEqual([]);
  });

  it('names an error response that spells its body out inline, even behind a response $ref', () => {
    const document = doc(
      {
        '/api/v1/a': {
          get: {
            responses: {
              ...ok(),
              '404': {
                description: 'missing',
                content: { 'application/problem+json': { schema: { type: 'object' } } },
              },
              '429': { $ref: '#/components/responses/TooManyRequests' },
            },
          },
        },
      },
      { Problem: { type: 'object' } },
    );
    document.components!.responses = {
      TooManyRequests: {
        description: 'slow down',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    };

    const findings = findInlineErrorSchemas(document);

    expect(findings).toEqual([
      'GET /api/v1/a (404 application/problem+json) declares an inline error body instead of a shared component schema',
      'GET /api/v1/a (429 application/json) declares an inline error body instead of a shared component schema',
    ]);
  });

  it('accepts an error body referencing a shared component and honours exclusions', () => {
    const document = doc(
      {
        '/api/v1/a': {
          get: {
            responses: {
              ...ok(),
              '404': {
                description: 'missing',
                content: {
                  'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
                },
              },
            },
          },
        },
        '/health/ready': {
          get: { responses: { '503': { description: 'down', content: { 'application/json': { schema: { type: 'object' } } } } } },
        },
      },
      { Problem: { type: 'object' } },
    );

    expect(findInlineErrorSchemas(document, new Map(), ['/health/ready'])).toEqual([]);
    expect(findInlineErrorSchemas(document)).toHaveLength(1);
  });

  it('names the standard error responses an operation is missing', () => {
    const findings = findOperationsMissingStandardErrors(
      [route('POST', '/api/v1/a/{id}', false, true), route('GET', '/health/live', true)],
      doc({
        '/api/v1/a/{id}': { post: { responses: { ...ok(), '401': { description: 'no' } } } },
        '/health/live': { get: { responses: ok() } },
      }),
      {
        always: [429, 500],
        authenticated: [401, 403],
        withBody: [400],
        withTrailingPathParam: [404],
        exclusions: ['/health/live'],
      },
    );

    expect(findings).toEqual([
      'POST /api/v1/a/{id} does not document the 400 error response',
      'POST /api/v1/a/{id} does not document the 403 error response',
      'POST /api/v1/a/{id} does not document the 404 error response',
      'POST /api/v1/a/{id} does not document the 429 error response',
      'POST /api/v1/a/{id} does not document the 500 error response',
    ]);
  });

  it('does not demand 404 from a scoped collection under a path parameter', () => {
    const responses = {
      ...ok(),
      '401': { description: 'no' },
      '403': { description: 'no' },
      '429': { description: 'slow down' },
      '500': { description: 'boom' },
    };

    expect(
      findOperationsMissingStandardErrors(
        [route('GET', '/api/v1/audit/resources/{resourceId}/timeline')],
        doc({ '/api/v1/audit/resources/{resourceId}/timeline': { get: { responses } } }),
        { always: [429, 500], authenticated: [401, 403], withBody: [400], withTrailingPathParam: [404] },
      ),
    ).toEqual([]);
  });

  it('names a component that re-declares the success envelope', () => {
    const findings = findDuplicateEnvelopeComponents(
      doc(
        { '/api/v1/a': { get: { responses: ok() } } },
        {
          ApiEnvelopeDto: {
            type: 'object',
            properties: { success: {}, data: {}, meta: {}, requestId: {} },
          },
          AgentEnvelopeDto: {
            type: 'object',
            properties: { success: {}, data: {}, meta: {}, requestId: {} },
          },
          AgentDto: { type: 'object', properties: { id: {} } },
        },
      ),
    );

    expect(findings).toEqual([
      'components.schemas.AgentEnvelopeDto re-declares the response envelope; compose ApiEnvelopeDto instead',
    ]);
  });

  it('finds nothing to report on a complete document', () => {
    const routes = [route('GET', '/api/v1/a')];
    const document = doc(
      {
        '/api/v1/a': {
          get: {
            summary: 'A',
            tags: ['fixture'],
            responses: { ...ok({ $ref: '#/components/schemas/A' }), '404': { description: 'missing' } },
            security: [{ 'access-token': [] }],
          },
        },
      },
      { A: { type: 'object' } },
    );

    expect(findRouteDocumentationGaps(routes, document)).toEqual([]);
    expect(findUnservedOperations(routes, document)).toEqual([]);
    expect(findOperationsWithoutSuccessSchema(document)).toEqual([]);
    expect(findOperationsWithUntypedRequestBody(document)).toEqual([]);
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

  it('fails on the temporary undocumented route and names its controller and handler', () => {
    expect(gapsOf('path', routes, document)).toEqual([
      'ScratchController.undocumented (POST /api/v1/scratch/undocumented): path /api/v1/scratch/undocumented is missing from the OpenAPI document',
    ]);
  });

  it('passes once that route is allowlisted with a reason', () => {
    const allowlist = [
      { method: 'POST', path: '/api/v1/scratch/undocumented', reason: 'fixture' },
    ];
    expect(gapsOf('path', routes, document, { allowlist })).toEqual([]);
    expect(findStaleAllowlistEntries(routes, document, allowlist)).toEqual([]);
  });

  it('names the guarded route that declares no security scheme', () => {
    expect(gapsOf('security', routes, document)).toEqual([
      'ScratchController.twice (GET /api/v1/scratch/twice): is guarded but declares no security requirement (@ApiBearerAuth / @ApiSecurity)',
      'ScratchController.twice (GET /api/v1/scratch/twice): is guarded but declares no security requirement (@ApiBearerAuth / @ApiSecurity)',
      'ScratchController.unsecured (GET /api/v1/scratch/unsecured): is guarded but declares no security requirement (@ApiBearerAuth / @ApiSecurity)',
    ]);
  });

  it('accepts the @Public() route that declares no security scheme', () => {
    expect(gapsOf('publicSecurity', routes, document)).toEqual([]);
  });

  it('names the route registered twice', () => {
    expect(findDuplicateRoutes(routes)).toEqual([
      'GET /api/v1/scratch/twice is registered by ScratchController.twice, ScratchController.twice',
    ]);
  });

  it('finds operations without success envelope and names them', () => {
    const documentWithoutEnvelope = doc({
      '/api/v1/raw': {
        get: {
          summary: 'Raw route',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/api/v1/enveloped': {
        get: {
          summary: 'Enveloped route',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    allOf: [{ $ref: '#/components/schemas/ApiEnvelopeDto' }],
                  },
                },
              },
            },
          },
        },
      },
    });

    const findings = findOperationsWithoutSuccessEnvelope(documentWithoutEnvelope);
    expect(findings).toEqual([
      'GET /api/v1/raw does not declare a success response using the { success, data, meta, requestId } envelope',
    ]);
  });

  it('allows exclusions from the envelope check when explicitly listed', () => {
    const documentWithRaw = doc({
      '/api/v1/health': {
        get: {
          summary: 'Raw health',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    });

    expect(
      findOperationsWithoutSuccessEnvelope(documentWithRaw, new Map(), ['/api/v1/health']),
    ).toEqual([]);
  });

  it('accepts schemas declaring the four envelope properties directly', () => {
    const documentDirectEnvelope = doc({
      '/api/v1/direct': {
        get: {
          summary: 'Direct envelope',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { type: 'object' },
                      meta: { type: 'object' },
                      requestId: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(findOperationsWithoutSuccessEnvelope(documentDirectEnvelope)).toEqual([]);
  });
});
