import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { PrismaService } from './database/prisma.service';
import { AppModule } from './app.module';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAPIObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { GLOBAL_PREFIX_EXCLUDED_ROUTES } from './common/constants/global-prefix';
import {
  AllowlistedRoute,
  RegisteredRoute,
  collectRefs,
  findDanglingRefs,
  findDuplicateRoutes,
  findOperationsMissingSecurity,
  findOperationsWithoutSuccessSchema,
  findOperationsWithUntypedRequestBody,
  findStaleAllowlistEntries,
  findUndocumentedRoutes,
  findUnservedOperations,
  listDocumentedOperations,
  listRegisteredRoutes,
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

/**
 * Routes deliberately left out of the OpenAPI document. Every entry must still
 * be served and still be undocumented, or the allowlist check fails, so an entry
 * cannot outlive its reason.
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
];

/**
 * The liveness probes only ever answer 200 — they are not part of the
 * authenticated surface and have no error to report.
 */
const LIVENESS_PROBES = ['/health/live', '/api/v1/health/liveness'];

/** Paths the API serves outside its prefix, as they appear in the document. */
const UNPREFIXED_PATHS = new Set(GLOBAL_PREFIX_EXCLUDED_ROUTES.map((route) => `/${route.path}`));

/** List endpoints that page with an opaque cursor rather than an offset. */
const CURSOR_PAGINATED_ROUTES = [
  '/api/v1/audit',
  '/api/v1/transactions',
  '/api/v1/webhooks/deliveries',
];

describe('OpenAPI Documentation', () => {
  let app: INestApplication;
  let moduleFixture: TestingModule;
  let document: OpenAPIObject;
  let routes: RegisteredRoute[];

  beforeAll(async () => {
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

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Astroid API')
      .setDescription(
        'The intelligence layer for the Financial Operating System for autonomous AI agents on Stellar.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'api-key')
      .build();

    document = SwaggerModule.createDocument(app, swaggerConfig);
    routes = listRegisteredRoutes(app);
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

  it('documents every registered route with its method and path', () => {
    expect(findUndocumentedRoutes(routes, document, INTERNAL_ROUTES)).toEqual([]);
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
    ).toMatchObject({ required: false });
  });

  it('gives every operation a summary or description', () => {
    const offenders = listDocumentedOperations(document)
      .filter(({ operation }) => !(operation.summary || operation.description))
      .map(routeKey);
    expect(offenders).toEqual([]);
  });

  it('documents a 2xx response with a schema for every operation', () => {
    expect(findOperationsWithoutSuccessSchema(document)).toEqual([]);
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

  it('declares a defined security scheme on every authenticated operation', () => {
    expect(findOperationsMissingSecurity(routes, document)).toEqual([]);
  });

  it('should have security schemes defined', () => {
    expect(document.components?.securitySchemes).toBeDefined();
    expect(document.components?.securitySchemes?.['access-token']).toBeDefined();
    expect(document.components?.securitySchemes?.['api-key']).toBeDefined();
  });

  it('should have tags for all endpoints', () => {
    const offenders = listDocumentedOperations(document)
      .filter(({ operation }) => !Array.isArray(operation.tags) || operation.tags.length === 0)
      .map(routeKey);
    expect(offenders).toEqual([]);
  });

  // ── Documentation validity ───────────────────────────────────────────────

  it('resolves every schema reference (no missing type definitions)', () => {
    expect(findDanglingRefs(document)).toEqual([]);
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
    for (const { method, path, operation } of listDocumentedOperations(document)) {
      const errorResponses = Object.entries(operation.responses).filter(([status]) =>
        status.startsWith('4') || status.startsWith('5'),
      );
      if (LIVENESS_PROBES.includes(path)) {
        expect(errorResponses.length, `${method} ${path}`).toBe(0);
        continue;
      }
      expect(errorResponses.length, `${method} ${path}`).toBeGreaterThan(0);

      for (const [status, response] of errorResponses) {
        const content = (response as { content?: Record<string, unknown> }).content;
        expect(content, `${method} ${path} (${status})`).toBeDefined();
      }
    }
  });
});
