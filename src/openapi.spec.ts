import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { SwaggerModule } from '@nestjs/swagger';
import { PrismaService } from './database/prisma.service';
import { AppModule } from './app.module';
import { INestApplication } from '@nestjs/common';
import { CONTROLLER_WATERMARK } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { OpenAPIObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { GLOBAL_PREFIX_EXCLUDED_ROUTES } from './common/constants/global-prefix';
import { buildSwaggerConfig } from './common/openapi/swagger-config';
import {
  AllowlistedRoute,
  RegisteredRoute,
  RouteCheck,
  RouteDocumentationGap,
  collectRefs,
  findDanglingRefs,
  findDuplicateEnvelopeComponents,
  findInlineErrorSchemas,
  findDuplicateRoutes,
  findMissingDeclaredSchemas,
  findMissingRequestSchemas,
  findOperationsMissingSecuritySchemes,
  findOperationsMissingStandardErrors,
  findOperationsWithoutResponses,
  findOperationsWithoutSuccessEnvelope,
  findOperationsWithoutSuccessSchema,
  findRouteDocumentationGaps,
  findStaleAllowlistEntries,
  findStaleClientErrorExemptions,
  findUnservedOperations,
  listDocumentedOperations,
  listRegisteredRoutes,
  routeHandlers,
  routeKey,
} from './common/openapi/openapi-coverage';

// Set up environment variables before importing modules that depend on them
process.env.NODE_ENV = 'test';
process.env.APP_NAME = 'astroid-api';
process.env.PORT = '3000';
process.env.API_PREFIX = 'api/v1';
process.env.LOG_LEVEL = 'info';
process.env.CORS_ORIGINS = '*';

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.DATABASE_CONNECTION_LIMIT = '10';
process.env.DATABASE_WORKER_CONNECTION_LIMIT = '3';
process.env.DATABASE_POOL_TIMEOUT_MS = '5000';
process.env.DATABASE_QUERY_TIMEOUT_MS = '5000';
process.env.DATABASE_STATEMENT_TIMEOUT_MS = '10000';
process.env.DATABASE_WORKER_QUERY_TIMEOUT_MS = '60000';

process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.REDIS_PASSWORD = '';
process.env.REDIS_DB = '0';

process.env.JWT_ACCESS_SECRET = 'test-secret-key-32-chars-long!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32-chars!!';
process.env.JWT_ACCESS_TTL = '900';
process.env.JWT_REFRESH_TTL = '1209600';
process.env.PASSKEY_RP_ID = 'localhost';
process.env.PASSKEY_RP_NAME = 'Astroid';
process.env.PASSKEY_ORIGIN = 'http://localhost:3001';

process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.STELLAR_SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
process.env.STELLAR_REGISTRY_CONTRACT_ID = '';
process.env.STELLAR_USE_MOCK = 'true';

process.env.STORAGE_ENDPOINT = 'http://localhost:9000';
process.env.STORAGE_REGION = 'us-east-1';
process.env.STORAGE_BUCKET = 'astroid';
process.env.STORAGE_ACCESS_KEY = 'astroid';
process.env.STORAGE_SECRET_KEY = 'astroid-secret';

process.env.QUEUE_PREFIX = 'astroid';
process.env.QUEUE_CONCURRENCY = '5';

process.env.THROTTLE_AUTH_LIMIT = '10';
process.env.THROTTLE_API_LIMIT = '120';
process.env.THROTTLE_TTL = '60';

process.env.AI_PROVIDER = 'nvidia';
process.env.AI_PROVIDER_KEY = 'test-key';
process.env.AI_BASE_URL = 'https://integrate.api.nvidia.com/v1';
process.env.AI_MODEL = 'meta/llama-3.1-70b-instruct';

const MODULES_DIR = join(process.cwd(), 'src', 'modules');

function controllerFiles(directory: string = MODULES_DIR): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return controllerFiles(path);
    if (!entry.name.endsWith('.controller.ts')) return [];
    return [relative(MODULES_DIR, path).split(sep).join('/')];
  });
}

/**
 * Every `@Controller()` class exported by a `*.controller.ts` file under
 * src/modules, found by importing the file and reading Nest's controller
 * metadata. Guards the route checks against a controller that exists on disk
 * but is not registered in any module (its routes would silently be skipped).
 */
async function controllerClassesOnDisk(): Promise<Array<{ file: string; name: string }>> {
  const controllers: Array<{ file: string; name: string }> = [];
  for (const file of controllerFiles()) {
    const exported = (await import(`./modules/${file}`)) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value === 'function' && Reflect.getMetadata(CONTROLLER_WATERMARK, value) === true) {
        controllers.push({ file, name: value.name });
      }
    }
  }
  return controllers;
}

function operationLabel(
  operation: { method: string; path: string },
  handlers: ReadonlyMap<string, string>,
): string {
  const key = routeKey(operation);
  const handler = handlers.get(key);
  return handler ? `${key} (${handler})` : key;
}

/**
 * Routes deliberately left out of the OpenAPI document. Every entry must still
 * be served and still be undocumented, or the allowlist check fails, so an entry
 * cannot outlive its reason. Orchestrator probes (/health/live, /health/ready)
 * are documented with standard response envelopes because infrastructure consumes them.
 * Richer diagnostic health routes are internal and un-enveloped, so they are explicitly
 * allowlisted here.
 */
const INTERNAL_ROUTES: AllowlistedRoute[] = [
  {
    method: 'GET',
    path: '/metrics',
    // Prometheus scrape target: unversioned, text exposition format rather than
    // JSON, and meant for the monitoring network, not API clients
    // (`@ApiExcludeController()` in metrics.controller.ts).
    reason: 'Prometheus scrape endpoint for the monitoring network, not part of the client API',
  },
  {
    method: 'POST',
    path: '/api/v1/webhooks/receive',
    // Inbound partner webhooks, authenticated by an HMAC signature header instead
    // of the bearer or API-key schemes the document defines
    // (`@ApiExcludeController()` in webhook-ingress.controller.ts).
    reason: 'Partner webhook ingress authenticated by HMAC signature, not by the documented schemes',
  },
  {
    method: 'GET',
    path: '/api/v1/health',
    // Internal root health check returning raw HealthStatusDto for service orchestrators.
    reason: 'Internal application health diagnostic returning raw HealthStatusDto without client envelope',
  },
  {
    method: 'GET',
    path: '/api/v1/health/liveness',
    // Diagnostic probe returning un-enveloped liveness report.
    reason: 'Internal process liveness diagnostic returning raw status report for infrastructure',
  },
  {
    method: 'GET',
    path: '/api/v1/health/readiness',
    // Diagnostic probe returning un-enveloped readiness breakdown.
    reason: 'Internal dependency readiness diagnostic returning raw per-service status for infrastructure',
  },
  {
    method: 'GET',
    path: '/api/v1/health/database',
    // Diagnostic probe returning raw Prisma connection check.
    reason: 'Internal database connectivity diagnostic returning raw database status',
  },
  {
    method: 'GET',
    path: '/api/v1/health/redis',
    // Diagnostic probe returning raw Redis connection check.
    reason: 'Internal Redis connectivity diagnostic returning raw cache status',
  },
  {
    method: 'GET',
    path: '/api/v1/health/stellar',
    // Diagnostic probe returning raw Horizon and Soroban connectivity checks.
    reason: 'Internal Stellar connectivity diagnostic returning raw network and node status',
  },
  {
    method: 'GET',
    path: '/api/v1/operations/queues',
    // Queue observability endpoint excluded from OpenAPI to avoid circular dependency
    // with BullMQ Queue types during schema generation.
    reason: 'Queue observability endpoint excluded from OpenAPI document to avoid circular dependency with BullMQ types',
  },
];

/**
 * Documented routes exempt from the 4xx check, and only from that check: they
 * cannot answer with any client error, and documenting one would be false.
 * Every entry must still be served, documented and free of 4xx responses, or
 * the exemption check fails.
 */
const NO_CLIENT_ERROR_ROUTES: AllowlistedRoute[] = [
  {
    method: 'GET',
    path: '/health/live',
    // @Public(), takes no input and skips every rate limiter (health.controller.ts).
    reason: 'Liveness probe: public, takes no input and skips all rate limiting, so it only ever answers 200',
  },
  {
    method: 'GET',
    path: '/health/ready',
    // @Public(), takes no input and skips every rate limiter; 503 is its only error.
    reason: 'Readiness probe: public, takes no input and skips all rate limiting, so it answers only 200 or 503',
  },
];

/**
 * The per-route checks, one test each, so every kind of gap fails distinctly
 * and lists each offending route as `Controller.handler (METHOD /path): ...`.
 */
const ROUTE_CHECKS: ReadonlyArray<[RouteCheck, string]> = [
  ['path', 'documents the path of every registered route'],
  ['method', 'documents the HTTP method of every registered route on its path'],
  ['summary', 'gives every route operation a non-empty summary'],
  ['tags', 'gives every route operation at least one tag'],
  ['requestBody', 'documents a request body schema for every handler that takes a @Body()'],
  ['clientError', 'documents at least one 4xx error response for every route'],
  ['security', 'declares a defined security requirement on every guarded route'],
  ['publicSecurity', 'declares no security requirement on @Public() routes'],
];

/**
 * Infrastructure probes answer with the success envelope even when unhealthy
 * (`success: false` plus per-dependency detail), not with problem details, and
 * are exempt from the rate limiter. They are held to their own contract.
 */
const INFRASTRUCTURE_PROBES = ['/health/live', '/health/ready'];

/** Paths the API serves outside its prefix, as they appear in the document. */
const UNPREFIXED_PATHS = new Set(GLOBAL_PREFIX_EXCLUDED_ROUTES.map((route) => `/${route.path}`));

/** List endpoints supporting both standard pages and legacy cursors. */
const PAGE_OR_CURSOR_PAGINATED_ROUTES = ['/api/v1/audit', '/api/v1/transactions'];

/** List endpoints that page only with an opaque cursor. */
const CURSOR_PAGINATED_ROUTES = [
  '/api/v1/webhooks/deliveries',
];

describe('OpenAPI Documentation', () => {
  let app: INestApplication;
  let moduleFixture: TestingModule;
  let document: OpenAPIObject;
  let routes: RegisteredRoute[];
  let handlers: Map<string, string>;
  let gaps: RouteDocumentationGap[];
  let controllersOnDisk: Array<{ file: string; name: string }>;

  beforeAll(async () => {
    // Read the controller files before the application starts: once it is
    // initialised its Redis-backed queue clients begin connecting, and the
    // tests below must not yield to them (see afterAll).
    controllersOnDisk = await controllerClassesOnDisk();

    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        enableShutdownHooks: vi.fn(),
        onModuleInit: vi.fn(),
        onModuleDestroy: vi.fn(),
        $connect: vi.fn(),
        $disconnect: vi.fn(),
        workerClient: {
          $connect: vi.fn(),
          $disconnect: vi.fn(),
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();

    // Apply the global prefix exactly as main.ts does, exclusions included, so
    // the document carries the paths the API really serves.
    const configService = app.get(ConfigService);
    const appConfig = configService.getOrThrow('app');
    app.setGlobalPrefix(appConfig.apiPrefix, { exclude: GLOBAL_PREFIX_EXCLUDED_ROUTES });

    await app.init();

    // The same configuration main.ts serves at /docs.
    document = SwaggerModule.createDocument(app, buildSwaggerConfig());
    routes = listRegisteredRoutes(app);
    handlers = routeHandlers(routes);
    gaps = findRouteDocumentationGaps(routes, document, {
      allowlist: INTERNAL_ROUTES,
      noClientErrorRoutes: NO_CLIENT_ERROR_ROUTES,
    });
  }, 60_000);

  afterAll(async () => {
    // The full AppModule opens Redis-backed queue observers (DLQ listeners,
    // throttler storage) that cannot connect in a test environment; a graceful
    // close can hang waiting on those sockets, so bound it with a timer.
    await Promise.race([
      (async () => {
        await app.close();
        await moduleFixture.close();
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }, 15_000);

  it('should generate a valid OpenAPI document', () => {
    expect(document).toBeDefined();
    expect(document.openapi).toMatch(/^3\.0\./);
    expect(document.info).toEqual(buildSwaggerConfig().info);
    expect(document.info.title).toBe('Astroid API');
    expect(document.info.version).toBe('1.0');
    expect(document.paths).toBeDefined();
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
  });

  // ── Route coverage: the document against the application's router ───────

  it('enumerates the routes the application registers', () => {
    // A broken enumeration would make every coverage check below pass vacuously.
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.map(routeKey)).toEqual(
      expect.arrayContaining(['GET /health/live', 'GET /api/v1/agents/{id}']),
    );
  });

  it('registers every controller declared under src/modules, so none of its routes escape the checks', () => {
    const onDisk = controllersOnDisk;
    const registered = new Set(routes.map((route) => route.handler.split('.')[0]));

    expect(onDisk.length, 'no @Controller() classes found under src/modules').toBeGreaterThan(20);
    expect(
      controllerFiles().filter((file) => !onDisk.some((controller) => controller.file === file)),
      'controller files that export no @Controller() class',
    ).toEqual([]);
    expect(
      onDisk
        .filter(({ name }) => !registered.has(name))
        .map(({ file, name }) => `${name} (src/modules/${file}) is not registered in any module`),
    ).toEqual([]);
  });

  describe('per-route documentation', () => {
    it('checks every registered route that is not allowlisted', () => {
      const allowlisted = new Set(INTERNAL_ROUTES.map(routeKey));
      expect(routes.filter((route) => !allowlisted.has(routeKey(route))).length).toBeGreaterThan(100);
    });

    it.each(ROUTE_CHECKS)('%s: %s', (check) => {
      const failures = gaps.filter((gap) => gap.check === check).map((gap) => gap.message);
      expect(failures, `${failures.length} route(s) fail the '${check}' check`).toEqual([]);
    });

    it('keeps every 4xx exemption served, documented, still without a 4xx and justified', () => {
      expect(findStaleClientErrorExemptions(routes, document, NO_CLIENT_ERROR_ROUTES)).toEqual([]);
    });
  });

  it('documents only operations that a route serves', () => {
    expect(findUnservedOperations(routes, document)).toEqual([]);
  });

  it('registers each method and path from a single handler', () => {
    expect(findDuplicateRoutes(routes)).toEqual([]);
  });

  it('keeps every internal-route allowlist entry served, undocumented and justified', () => {
    expect(findStaleAllowlistEntries(routes, document, INTERNAL_ROUTES)).toEqual([]);
  });

  // ── Operation contents ───────────────────────────────────────────────────

  it('serves every path under the API prefix unless it is a documented exclusion', () => {
    const offenders = Object.keys(document.paths).filter(
      (path) => !/^\/api\/v1\//.test(path) && !UNPREFIXED_PATHS.has(path),
    );
    expect(offenders).toEqual([]);
  });

  it('documents the optional Idempotency-Key header on transaction creation', () => {
    const operation = document.paths['/api/v1/transactions']?.post;
    const parameters = (operation?.parameters ?? []) as Array<{
      name?: string;
      in?: string;
      required?: boolean;
    }>;

    expect(
      parameters.find((parameter) => parameter.in === 'header' && parameter.name === 'Idempotency-Key'),
    ).toMatchObject({ required: true });
  });

  it('documents at least one response for every operation', () => {
    expect(findOperationsWithoutResponses(document, handlers)).toEqual([]);
  });

  it('documents a 2xx response with a schema for every operation', () => {
    expect(findOperationsWithoutSuccessSchema(document, handlers)).toEqual([]);
  });

  it('declares a success response using the { success, data, meta, requestId } envelope on every operation', () => {
    expect(findOperationsWithoutSuccessEnvelope(document, handlers)).toEqual([]);
  });

  it('documents a named request DTO schema for every route with a request body', () => {
    expect(findMissingRequestSchemas(routes, document, INTERNAL_ROUTES, handlers)).toEqual([]);
  });

  it('resolves every response and request DTO schema declared by a handler', () => {
    expect(findMissingDeclaredSchemas(routes, document, handlers)).toEqual([]);
  });

  it('documents cursor pagination inputs and meta on the paginated list endpoints', () => {
    const metaSchema = document.components?.schemas?.['CursorPaginationMetaDto'] as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(metaSchema).toBeDefined();
    expect(Object.keys(metaSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(['limit', 'hasMore', 'nextCursor']),
    );

    for (const path of CURSOR_PAGINATED_ROUTES) {
      const operation = document.paths[path]?.get;
      expect(operation, path).toBeDefined();

      const parameters = (operation?.parameters ?? []).map(
        (parameter) => (parameter as { name?: string }).name,
      );
      expect(parameters, path).toEqual(expect.arrayContaining(['cursor', 'limit']));

      const success = Object.entries(operation?.responses ?? {}).find(([status]) =>
        status.startsWith('2'),
      );
      expect(success, path).toBeDefined();
      const content = (success![1] as { content?: Record<string, { schema?: unknown }> }).content;
      const schema = Object.values(content ?? {})[0]?.schema;
      expect(collectRefs(schema).has('#/components/schemas/CursorPaginationMetaDto'), path).toBe(
        true,
      );
    }
  });

  it('documents standard page metadata on page-paginated list endpoints', () => {
    const metaSchema = document.components?.schemas?.['PaginationMetaDto'] as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(metaSchema).toBeDefined();
    expect(Object.keys(metaSchema?.properties ?? {})).toEqual(
      expect.arrayContaining([
        'page',
        'pageSize',
        'total',
        'totalPages',
        'hasNextPage',
        'hasPreviousPage',
      ]),
    );

    for (const path of PAGE_OR_CURSOR_PAGINATED_ROUTES) {
      const operation = document.paths[path]?.get;
      expect(operation, path).toBeDefined();
      const parameters = (operation?.parameters ?? []).map(
        (parameter) => (parameter as { name?: string }).name,
      );
      expect(parameters, path).toEqual(expect.arrayContaining(['page', 'pageSize']));

      const success = Object.entries(operation?.responses ?? {}).find(([status]) =>
        status.startsWith('2'),
      );
      const content = (success?.[1] as { content?: Record<string, { schema?: unknown }> } | undefined)
        ?.content;
      const schema = Object.values(content ?? {})[0]?.schema;
      expect(collectRefs(schema).has('#/components/schemas/PaginationMetaDto'), path).toBe(true);
    }
  });

  it('offers every scheme the authentication guard accepts on protected operations', () => {
    expect(
      findOperationsMissingSecuritySchemes(routes, document, ['access-token', 'api-key'], handlers),
    ).toEqual([]);
  });

  it('references a shared component schema for every error response body', () => {
    expect(findInlineErrorSchemas(document, handlers, INFRASTRUCTURE_PROBES)).toEqual([]);
  });

  it('documents the standard error responses each operation can answer with', () => {
    expect(
      findOperationsMissingStandardErrors(
        routes,
        document,
        {
          always: [429, 500],
          authenticated: [401, 403],
          withBody: [400],
          withTrailingPathParam: [404],
          exclusions: INFRASTRUCTURE_PROBES,
        },
        handlers,
      ),
    ).toEqual([]);
  });

  it('declares the success envelope in exactly one component schema', () => {
    expect(findDuplicateEnvelopeComponents(document)).toEqual([]);
  });

  it('should have security schemes defined', () => {
    expect(document.components?.securitySchemes).toBeDefined();
    expect(document.components?.securitySchemes?.['access-token']).toBeDefined();
    expect(document.components?.securitySchemes?.['api-key']).toBeDefined();
  });

  // ── Documentation validity ───────────────────────────────────────────────

  it('resolves every schema reference (no missing type definitions)', () => {
    expect(findDanglingRefs(document, handlers)).toEqual([]);
  });

  it('documents every property of every schema', () => {
    const schemas = document.components?.schemas ?? {};

    for (const [name, schema] of Object.entries(schemas)) {
      const properties = (schema as { properties?: Record<string, Record<string, unknown>> })
        .properties;
      if (!properties) continue;

      for (const [property, definition] of Object.entries(properties)) {
        const ref = definition.$ref as string | undefined;
        const referenced = ref ? schemas[ref.split('/').pop() as string] : undefined;
        const description =
          definition.description ??
          (referenced as { description?: string } | undefined)?.description;

        expect(description, `${name}.${property}`).toBeDefined();
      }
    }
  });

  it('documents the shared error envelope for every error response', () => {
    // That every route documents a 4xx at all is the per-route 'clientError' check.
    for (const { method, path, operation } of listDocumentedOperations(document)) {
      const errorResponses = Object.entries(operation.responses).filter(([status]) =>
        status.startsWith('4') || status.startsWith('5'),
      );
      const label = operationLabel({ method, path }, handlers);

      for (const [status, response] of errorResponses) {
        const content = (response as { content?: Record<string, unknown> }).content;
        expect(content, `${label} (${status})`).toBeDefined();
      }
    }
  });

  // ── Developer surface: API key lifecycle ─────────────────────────────────
  //
  // These tests make the drift check meaningful for the developer surface:
  // if a path is removed, renamed, or its schema fields change, docs:check
  // fails and forces the author to update the spec deliberately.

  describe('API key endpoints', () => {
    /**
     * Returns the OperationObject for a documented path+method, or throws a
     * clear error so the test name in the report names the missing operation.
     */
    function operation(path: string, method: 'get' | 'post' | 'delete' | 'patch') {
      const item = document.paths[path] as Record<string, unknown> | undefined;
      const op = item?.[method] as Record<string, unknown> | undefined;
      return op;
    }

    it('documents GET /api/v1/developer/api-keys with the developer tag and bearer auth', () => {
      const op = operation('/api/v1/developer/api-keys', 'get');
      expect(op, 'GET /api/v1/developer/api-keys must be documented').toBeDefined();
      expect((op!.tags as string[]).includes('developer')).toBe(true);
      const security = op!.security as Array<Record<string, unknown>> | undefined;
      expect(
        security?.some((s) => 'access-token' in s),
        'GET /api/v1/developer/api-keys must require the bearer access-token scheme',
      ).toBe(true);
    });

    it('documents GET /api/v1/developer/api-keys with pagination parameters', () => {
      const op = operation('/api/v1/developer/api-keys', 'get');
      const params = ((op?.parameters ?? []) as Array<{ name?: string }>).map((p) => p.name);
      expect(params, 'list endpoint must carry page pagination parameters').toEqual(
        expect.arrayContaining(['page', 'pageSize']),
      );
    });

    it('documents POST /api/v1/developer/api-keys with a 201 response containing ApiKeyCreatedDto', () => {
      const op = operation('/api/v1/developer/api-keys', 'post');
      expect(op, 'POST /api/v1/developer/api-keys must be documented').toBeDefined();
      expect(Object.keys(op!.responses as object)).toContain('201');
      const refs = collectRefs(op!.responses);
      expect(
        refs.has('#/components/schemas/ApiKeyCreatedDto'),
        'POST response must reference ApiKeyCreatedDto',
      ).toBe(true);
    });

    it('documents POST /api/v1/developer/api-keys with a request body schema', () => {
      const op = operation('/api/v1/developer/api-keys', 'post');
      const refs = collectRefs(op?.requestBody);
      expect(
        refs.has('#/components/schemas/CreateApiKeyDto'),
        'POST must reference CreateApiKeyDto in request body',
      ).toBe(true);
    });

    it('documents POST /api/v1/developer/api-keys/{id}/rotate with a new-key response', () => {
      const op = operation('/api/v1/developer/api-keys/{id}/rotate', 'post');
      expect(op, 'POST /api/v1/developer/api-keys/{id}/rotate must be documented').toBeDefined();
      expect(Object.keys(op!.responses as object)).toContain('200');
      const refs = collectRefs(op!.responses);
      expect(
        refs.has('#/components/schemas/ApiKeyRotatedDto'),
        'rotate response must reference ApiKeyRotatedDto',
      ).toBe(true);
    });

    it('documents DELETE /api/v1/developer/api-keys/{id} with an ApiKeyRevokedDto response', () => {
      const op = operation('/api/v1/developer/api-keys/{id}', 'delete');
      expect(op, 'DELETE /api/v1/developer/api-keys/{id} must be documented').toBeDefined();
      const refs = collectRefs(op!.responses);
      expect(
        refs.has('#/components/schemas/ApiKeyRevokedDto'),
        'revoke response must reference ApiKeyRevokedDto',
      ).toBe(true);
    });

    it('defines the ApiKeyCreatedDto schema with key, id, prefix, and scopes fields', () => {
      const schema = document.components?.schemas?.['ApiKeyCreatedDto'] as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(schema, 'ApiKeyCreatedDto schema must be defined').toBeDefined();
      expect(Object.keys(schema!.properties ?? {})).toEqual(
        expect.arrayContaining(['id', 'prefix', 'scopes', 'key']),
      );
    });

    it('defines the ApiKeyResponseDto schema without a key or secret field (secrets never returned on reads)', () => {
      const schema = document.components?.schemas?.['ApiKeyResponseDto'] as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(schema, 'ApiKeyResponseDto schema must be defined').toBeDefined();
      const fields = Object.keys(schema!.properties ?? {});
      // The list/read response must never expose the raw key.
      expect(fields).not.toContain('key');
      expect(fields).not.toContain('secret');
      // But it must carry identifying metadata.
      expect(fields).toEqual(expect.arrayContaining(['id', 'name', 'prefix', 'scopes']));
    });

    it('defines the ApiKeyRotatedDto schema with previousKeyId and previousKeyExpiresAt', () => {
      const schema = document.components?.schemas?.['ApiKeyRotatedDto'] as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(schema, 'ApiKeyRotatedDto schema must be defined').toBeDefined();
      expect(Object.keys(schema!.properties ?? {})).toEqual(
        expect.arrayContaining(['id', 'key', 'previousKeyId', 'previousKeyExpiresAt']),
      );
    });

    it('does not expose a full raw key value in the ApiKeyCreatedDto key field example', () => {
      // The spec must not contain a real API key in the example — only a
      // placeholder description. We verify no example looks like a real key
      // (long random alphanumeric string starting with a typical prefix).
      const schema = document.components?.schemas?.['ApiKeyCreatedDto'] as
        | { properties?: Record<string, { example?: unknown; description?: string }> }
        | undefined;
      const keyExample = schema?.properties?.['key']?.example;
      // The key field should have no concrete example value that looks like a
      // real key (a real key would be 40+ chars starting with ak_ or ast_).
      if (keyExample !== undefined) {
        expect(typeof keyExample === 'string' && /^(ak_|ast_).{30,}/.test(String(keyExample))).toBe(false);
      }
    });
  });

  describe('Webhook endpoints', () => {
    function operation(path: string, method: 'get' | 'post' | 'delete' | 'patch') {
      const item = document.paths[path] as Record<string, unknown> | undefined;
      return item?.[method] as Record<string, unknown> | undefined;
    }

    it('documents GET /api/v1/webhooks with the webhooks tag and bearer auth', () => {
      const op = operation('/api/v1/webhooks', 'get');
      expect(op, 'GET /api/v1/webhooks must be documented').toBeDefined();
      expect((op!.tags as string[]).includes('webhooks')).toBe(true);
      const security = op!.security as Array<Record<string, unknown>> | undefined;
      expect(
        security?.some((s) => 'access-token' in s),
        'GET /api/v1/webhooks must require the bearer access-token scheme',
      ).toBe(true);
    });

    it('documents GET /api/v1/webhooks with pagination parameters', () => {
      const op = operation('/api/v1/webhooks', 'get');
      const params = ((op?.parameters ?? []) as Array<{ name?: string }>).map((p) => p.name);
      expect(params).toEqual(expect.arrayContaining(['page', 'pageSize']));
    });

    it('documents POST /api/v1/webhooks with a 201 response containing the signing secret', () => {
      const op = operation('/api/v1/webhooks', 'post');
      expect(op, 'POST /api/v1/webhooks must be documented').toBeDefined();
      expect(Object.keys(op!.responses as object)).toContain('201');
      const refs = collectRefs(op!.responses);
      expect(
        refs.has('#/components/schemas/WebhookSecretDto'),
        'POST response must reference WebhookSecretDto (the one-time secret)',
      ).toBe(true);
    });

    it('documents POST /api/v1/webhooks with a request body referencing CreateWebhookDto', () => {
      const op = operation('/api/v1/webhooks', 'post');
      const refs = collectRefs(op?.requestBody);
      expect(
        refs.has('#/components/schemas/CreateWebhookDto'),
        'POST must reference CreateWebhookDto in request body',
      ).toBe(true);
    });

    it('documents GET /api/v1/webhooks/{id} with a WebhookResponseDto response', () => {
      const op = operation('/api/v1/webhooks/{id}', 'get');
      expect(op, 'GET /api/v1/webhooks/{id} must be documented').toBeDefined();
      const refs = collectRefs(op!.responses);
      expect(refs.has('#/components/schemas/WebhookResponseDto')).toBe(true);
    });

    it('documents PATCH /api/v1/webhooks/{id} for webhook updates', () => {
      const op = operation('/api/v1/webhooks/{id}', 'patch');
      expect(op, 'PATCH /api/v1/webhooks/{id} must be documented').toBeDefined();
      expect(Object.keys(op!.responses as object).some(s => s.startsWith('2'))).toBe(true);
    });

    it('documents DELETE /api/v1/webhooks/{id} for webhook deletion', () => {
      const op = operation('/api/v1/webhooks/{id}', 'delete');
      expect(op, 'DELETE /api/v1/webhooks/{id} must be documented').toBeDefined();
      expect(Object.keys(op!.responses as object).some(s => s.startsWith('2'))).toBe(true);
    });

    it('documents POST /api/v1/webhooks/{id}/rotate-secret with a one-time secret response', () => {
      const op = operation('/api/v1/webhooks/{id}/rotate-secret', 'post');
      expect(op, 'POST /api/v1/webhooks/{id}/rotate-secret must be documented').toBeDefined();
      const refs = collectRefs(op!.responses);
      expect(
        refs.has('#/components/schemas/WebhookSecretDto'),
        'rotate-secret response must reference WebhookSecretDto',
      ).toBe(true);
    });

    it('documents GET /api/v1/webhooks/deliveries with cursor pagination', () => {
      const op = operation('/api/v1/webhooks/deliveries', 'get');
      expect(op, 'GET /api/v1/webhooks/deliveries must be documented').toBeDefined();
      const params = ((op?.parameters ?? []) as Array<{ name?: string }>).map((p) => p.name);
      expect(params).toEqual(expect.arrayContaining(['cursor', 'limit']));
      const refs = collectRefs(op!.responses);
      expect(
        refs.has('#/components/schemas/WebhookDeliveryDto'),
        'deliveries response must reference WebhookDeliveryDto',
      ).toBe(true);
    });

    it('defines the WebhookResponseDto schema with the required fields', () => {
      const schema = document.components?.schemas?.['WebhookResponseDto'] as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(schema, 'WebhookResponseDto schema must be defined').toBeDefined();
      expect(Object.keys(schema!.properties ?? {})).toEqual(
        expect.arrayContaining(['id', 'url', 'events', 'enabled', 'createdAt']),
      );
    });

    it('defines the WebhookSecretDto schema with only the secret field (no other internals)', () => {
      const schema = document.components?.schemas?.['WebhookSecretDto'] as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(schema, 'WebhookSecretDto schema must be defined').toBeDefined();
      expect(Object.keys(schema!.properties ?? {})).toContain('secret');
    });

    it('does not expose a signing secret value in example payloads', () => {
      // The WebhookSecretDto.secret field must not carry a concrete example
      // that looks like a real HMAC key (32+ hex/base64 characters).
      const schema = document.components?.schemas?.['WebhookSecretDto'] as
        | { properties?: Record<string, { example?: unknown }> }
        | undefined;
      const secretExample = schema?.properties?.['secret']?.example;
      if (secretExample !== undefined) {
        expect(
          typeof secretExample === 'string' && /^[A-Fa-f0-9]{32,}$/.test(String(secretExample)),
          'WebhookSecretDto.secret example must not look like a real HMAC signing key',
        ).toBe(false);
      }
    });

    it('defines the WebhookDeliveryDto schema with status and attempts fields', () => {
      const schema = document.components?.schemas?.['WebhookDeliveryDto'] as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(schema, 'WebhookDeliveryDto schema must be defined').toBeDefined();
      expect(Object.keys(schema!.properties ?? {})).toEqual(
        expect.arrayContaining(['id', 'webhookId', 'eventName', 'status', 'attempts']),
      );
    });
  });
});
