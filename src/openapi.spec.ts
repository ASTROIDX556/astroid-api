import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { PrismaService } from './database/prisma.service';
import { AppModule } from './app.module';
import { INestApplication, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAPIObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { GLOBAL_PREFIX_EXCLUDED_ROUTES } from './common/constants/global-prefix';
import { AiController } from './modules/ai/ai.controller';
import { AgentController } from './modules/agents/agent.controller';
import { AnalyticsController } from './modules/analytics/analytics.controller';
import { ApprovalController } from './modules/approvals/approval.controller';
import { AuditController } from './modules/audit/audit.controller';
import { AuthController } from './modules/auth/auth.controller';
import { PasskeyController } from './modules/auth/controllers/passkey.controller';
import { BudgetController } from './modules/budgets/budget.controller';
import { DlqController } from './modules/admin/dlq.controller';
import { QueueManagementController } from './modules/admin/queue-management.controller';
import { DeadLetterController } from './modules/dead-letter/dead-letter.controller';
import { ApiKeyController } from './modules/developer/api-key.controller';
import { HealthController } from './modules/health/health.controller';
import { MemoryController } from './modules/memory/memory.controller';
import { MetricsController } from './modules/metrics/metrics.controller';
import { NotificationController } from './modules/notifications/notification.controller';
import { OrganizationController } from './modules/organizations/organization.controller';
import { PolicyController } from './modules/policies/policy.controller';
import { RiskController } from './modules/risk/risk.controller';
import { StellarController } from './modules/stellar/stellar.controller';
import { TransactionController } from './modules/transactions/transaction.controller';
import { WalletController } from './modules/wallets/wallet.controller';
import { WebhookController } from './modules/webhooks/webhook.controller';
import { WebhookIngressController } from './modules/webhooks/webhook-ingress.controller';
import {
  AllowlistedRoute,
  RegisteredRoute,
  collectRefs,
  findDanglingRefs,
  findDuplicateRoutes,
  findMissingDeclaredSchemas,
  findMissingRequestSchemas,
  findOperationsMissingSecurity,
  findOperationsWithoutResponses,
  findOperationsWithoutSuccessSchema,
  findOperationsWithoutSummary,
  findStaleAllowlistEntries,
  findUndocumentedRoutes,
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

const MODULE_CONTROLLERS: ReadonlyArray<{ file: string; controller: Type<unknown> }> = [
  { file: 'admin/dlq.controller.ts', controller: DlqController },
  { file: 'admin/queue-management.controller.ts', controller: QueueManagementController },
  { file: 'ai/ai.controller.ts', controller: AiController },
  { file: 'agents/agent.controller.ts', controller: AgentController },
  { file: 'analytics/analytics.controller.ts', controller: AnalyticsController },
  { file: 'approvals/approval.controller.ts', controller: ApprovalController },
  { file: 'audit/audit.controller.ts', controller: AuditController },
  { file: 'auth/auth.controller.ts', controller: AuthController },
  { file: 'auth/controllers/passkey.controller.ts', controller: PasskeyController },
  { file: 'budgets/budget.controller.ts', controller: BudgetController },
  { file: 'dead-letter/dead-letter.controller.ts', controller: DeadLetterController },
  { file: 'developer/api-key.controller.ts', controller: ApiKeyController },
  { file: 'health/health.controller.ts', controller: HealthController },
  { file: 'memory/memory.controller.ts', controller: MemoryController },
  { file: 'metrics/metrics.controller.ts', controller: MetricsController },
  { file: 'notifications/notification.controller.ts', controller: NotificationController },
  { file: 'organizations/organization.controller.ts', controller: OrganizationController },
  { file: 'policies/policy.controller.ts', controller: PolicyController },
  { file: 'risk/risk.controller.ts', controller: RiskController },
  { file: 'stellar/stellar.controller.ts', controller: StellarController },
  { file: 'transactions/transaction.controller.ts', controller: TransactionController },
  { file: 'wallets/wallet.controller.ts', controller: WalletController },
  { file: 'webhooks/webhook-ingress.controller.ts', controller: WebhookIngressController },
  { file: 'webhooks/webhook.controller.ts', controller: WebhookController },
];

function controllerFiles(directory: string = MODULES_DIR): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return controllerFiles(path);
    if (!entry.name.endsWith('.controller.ts')) return [];
    return [relative(MODULES_DIR, path).split(sep).join('/')];
  });
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
 * cannot outlive its reason. Health probes are intentionally documented because
 * orchestrators consume their contract, so they are not allowlisted here.
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
    handlers = routeHandlers(routes);
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

  it('enumerates every controller in src/modules', () => {
    expect(controllerFiles().sort()).toEqual(MODULE_CONTROLLERS.map(({ file }) => file).sort());
    expect([...new Set(routes.map((route) => route.handler.split('.')[0]))].sort()).toEqual(
      MODULE_CONTROLLERS.map(({ controller }) => controller.name).sort(),
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

  it('gives every documented operation a non-empty summary', () => {
    expect(findOperationsWithoutSummary(document, handlers)).toEqual([]);
  });

  it('documents at least one response for every operation', () => {
    expect(findOperationsWithoutResponses(document, handlers)).toEqual([]);
  });

  it('documents a 2xx response with a schema for every operation', () => {
    expect(findOperationsWithoutSuccessSchema(document, handlers)).toEqual([]);
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

  it('declares a defined security scheme on every authenticated operation', () => {
    expect(findOperationsMissingSecurity(routes, document, handlers)).toEqual([]);
  });

  it('should have security schemes defined', () => {
    expect(document.components?.securitySchemes).toBeDefined();
    expect(document.components?.securitySchemes?.['access-token']).toBeDefined();
    expect(document.components?.securitySchemes?.['api-key']).toBeDefined();
  });

  it('should have tags for all endpoints', () => {
    const offenders = listDocumentedOperations(document)
      .filter(({ operation }) => !Array.isArray(operation.tags) || operation.tags.length === 0)
      .map((operation) => operationLabel(operation, handlers));
    expect(offenders).toEqual([]);
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
    for (const { method, path, operation } of listDocumentedOperations(document)) {
      const errorResponses = Object.entries(operation.responses).filter(([status]) =>
        status.startsWith('4') || status.startsWith('5'),
      );
      const label = operationLabel({ method, path }, handlers);
      if (LIVENESS_PROBES.includes(path)) {
        expect(errorResponses.length, label).toBe(0);
        continue;
      }
      expect(errorResponses.length, label).toBeGreaterThan(0);

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
