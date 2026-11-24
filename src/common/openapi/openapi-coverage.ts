import { INestApplication, RequestMethod, Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ApplicationConfig, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { RoutePathFactory } from '@nestjs/core/router/route-path-factory';
import { getSchemaPath } from '@nestjs/swagger';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import {
  OpenAPIObject,
  OperationObject,
  PathItemObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Helpers behind `npm run docs:check` (`src/openapi.spec.ts`): they compare the
 * routes the Nest application actually registers with the operations of the
 * generated OpenAPI document. Every finding is a string that starts with
 * `METHOD /path`, so a failing assertion tells a contributor which endpoint to
 * fix without reading the test.
 */

/** The OpenAPI operation keys of a path item, in document order. */
export const OPERATION_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'trace',
] as const satisfies ReadonlyArray<keyof PathItemObject>;

/** A route the application registers, with its path in OpenAPI form. */
export interface RegisteredRoute {
  /** Upper-case HTTP method, e.g. `GET`. */
  method: string;
  /** Full served path with `{param}` placeholders, e.g. `/api/v1/agents/{id}`. */
  path: string;
  /** `Controller.method` that handles the route. */
  handler: string;
  /** Whether the handler or its controller is marked `@Public()`. */
  isPublic: boolean;
  /** Whether the handler declares a `@Body()` parameter. */
  acceptsBody?: boolean;
  /** The handler function, used to read its Swagger decorator metadata. */
  handlerFunction?: object;
}

/** A route that is deliberately left out of the OpenAPI document. */
export interface AllowlistedRoute {
  method: string;
  path: string;
  /** Why the route is not documented; required so every entry is justified. */
  reason: string;
}

/** A documented operation of the OpenAPI document. */
export interface DocumentedOperation {
  method: string;
  path: string;
  operation: OperationObject;
}

/** `GET /api/v1/agents/{id}`: the key every finding starts with. */
export function routeKey(route: { method: string; path: string }): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

/** Converts an Express route path (`/agents/:id`) to its OpenAPI form (`/agents/{id}`). */
export function toOpenApiPath(path: string): string {
  const converted = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return converted.length > 1 ? converted.replace(/\/+$/, '') : converted;
}

/**
 * Enumerates every controller route of the application from Nest's own router
 * metadata, with the full path built by Nest's `RoutePathFactory`, so the
 * global prefix and its exclusions are applied exactly as at runtime. Swagger is
 * not consulted: a route hidden with `@ApiExcludeEndpoint()` or
 * `@ApiExcludeController()` is still listed, which is the point.
 *
 * Must be called after `app.init()`.
 */
export function listRegisteredRoutes(app: INestApplication): RegisteredRoute[] {
  const discovery = app.get(DiscoveryService, { strict: false });
  const reflector = app.get(Reflector, { strict: false });
  const config = app.get(ApplicationConfig, { strict: false });
  const factory = new RoutePathFactory(config);
  const scanner = new MetadataScanner();
  const routes: RegisteredRoute[] = [];

  for (const wrapper of discovery.getControllers()) {
    const { metatype, instance } = wrapper;
    if (!metatype || !instance) continue;

    const controllerPaths = asArray<string>(Reflect.getMetadata(PATH_METADATA, metatype));
    const prototype = Object.getPrototypeOf(instance) as object;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function') continue;
      const methodPaths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (methodPaths === undefined) continue;

      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
      const isPublic =
        reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, metatype]) === true;
      const routeArgs = Reflect.getMetadata(ROUTE_ARGS_METADATA, metatype, methodName) as
        | Record<string, unknown>
        | undefined;
      const acceptsBody = Object.keys(routeArgs ?? {}).some((key) =>
        key.startsWith(`${RouteParamtypes.BODY}:`),
      );

      for (const ctrlPath of controllerPaths.length ? controllerPaths : ['']) {
        for (const methodPath of asArray<string>(methodPaths)) {
          const paths = factory.create(
            { ctrlPath, methodPath, globalPrefix: config.getGlobalPrefix() },
            requestMethod,
          );
          for (const path of paths) {
            routes.push({
              method: RequestMethod[requestMethod],
              path: toOpenApiPath(path),
              handler: `${metatype.name}.${methodName}`,
              isPublic,
              acceptsBody,
              handlerFunction: handler,
            });
          }
        }
      }
    }
  }

  return routes;
}

/** Every operation of the document, as `{ method, path, operation }`. */
export function listDocumentedOperations(document: OpenAPIObject): DocumentedOperation[] {
  const operations: DocumentedOperation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of OPERATION_METHODS) {
      const operation = item[method] as OperationObject | undefined;
      if (operation) {
        operations.push({ method: method.toUpperCase(), path, operation });
      }
    }
  }
  return operations;
}

/** Maps `METHOD /path` to the controller handler that serves it. */
export function routeHandlers(routes: RegisteredRoute[]): Map<string, string> {
  return new Map(routes.map((route) => [routeKey(route), route.handler]));
}

function describeFinding(
  route: { method: string; path: string },
  handlers: ReadonlyMap<string, string>,
  message = '',
): string {
  const handler = handlers.get(routeKey(route));
  const location = `${routeKey(route)}${handler ? ` (${handler})` : ''}`;
  return message ? `${location} ${message}` : location;
}

/** Documented operations with no response of any status. */
export function findOperationsWithoutResponses(
  document: OpenAPIObject,
  handlers: ReadonlyMap<string, string> = new Map(),
): string[] {
  return sorted(
    listDocumentedOperations(document)
      .filter(({ operation }) => !operation.responses || Object.keys(operation.responses).length === 0)
      .map((operation) => describeFinding(operation, handlers, 'documents no response')),
  );
}

type RequestBodyLike = { content?: Record<string, { schema?: unknown }> };

function requestBodyOf(
  operation: OperationObject,
  document: OpenAPIObject,
): RequestBodyLike | undefined {
  const body = operation.requestBody as (RequestBodyLike & { $ref?: string }) | undefined;
  if (!body) return undefined;
  if (typeof body.$ref === 'string') {
    return resolvePointer(document, body.$ref) as RequestBodyLike | undefined;
  }
  return body;
}

function hasNamedSchemaRef(node: unknown, schemas: Record<string, unknown>): boolean {
  return [...collectRefs(node)].some((ref) => {
    if (!ref.startsWith('#/components/schemas/')) return false;
    return ref.split('/').pop() as string in schemas;
  });
}

/** Body-accepting routes whose operation has no named request schema. */
export function findMissingRequestSchemas(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
  allowlist: AllowlistedRoute[] = [],
  handlers: ReadonlyMap<string, string> = new Map(),
): string[] {
  const documented = new Map(listDocumentedOperations(document).map((entry) => [routeKey(entry), entry.operation]));
  const allowed = new Set(allowlist.map(routeKey));
  const schemas = document.components?.schemas ?? {};
  const findings: string[] = [];

  for (const route of routes) {
    if (!route.acceptsBody || allowed.has(routeKey(route))) continue;
    const operation = documented.get(routeKey(route));
    if (!operation) continue;
    const body = requestBodyOf(operation, document);
    const contentSchemas = Object.values(body?.content ?? {}).map((media) => media.schema);
    if (!contentSchemas.some((schema) => hasNamedSchemaRef(schema, schemas))) {
      findings.push(
        describeFinding(
          route,
          handlers,
          'declares a request body with no DTO schema in components.schemas',
        ),
      );
    }
  }
  return sorted(findings);
}

type DeclaredMetadata = {
  in?: string;
  type?: unknown;
  schema?: unknown;
  content?: unknown;
};

function declaredSchemaRefs(handler: object): Set<string> {
  const refs = new Set<string>();
  const add = (metadata: DeclaredMetadata | undefined) => {
    if (!metadata) return;
    if (typeof metadata.type === 'function' && metadata.type !== String && metadata.type !== Object) {
      refs.add(getSchemaPath(metadata.type as Type<unknown>));
    }
    for (const source of [metadata.schema, metadata.content]) {
      for (const ref of collectRefs(source)) {
        if (ref.startsWith('#/components/schemas/')) refs.add(ref);
      }
    }
  };

  for (const metadata of Object.values(
    (Reflect.getMetadata(DECORATORS.API_RESPONSE, handler) ?? {}) as Record<string, DeclaredMetadata>,
  )) {
    add(metadata);
  }
  for (const metadata of (Reflect.getMetadata(DECORATORS.API_PARAMETERS, handler) ?? []) as DeclaredMetadata[]) {
    if (metadata.in === 'body') add(metadata);
  }
  return refs;
}

/** DTO schemas declared by a handler that the generated operation does not carry. */
export function findMissingDeclaredSchemas(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
  handlers: ReadonlyMap<string, string> = new Map(),
): string[] {
  const documented = new Map(listDocumentedOperations(document).map((entry) => [routeKey(entry), entry.operation]));
  const schemas = document.components?.schemas ?? {};
  const findings: string[] = [];

  for (const route of routes) {
    const operation = documented.get(routeKey(route));
    if (!operation) continue;
    const actual = new Set<string>();
    for (const source of [operation.responses, operation.requestBody]) {
      for (const ref of collectRefs(source)) actual.add(ref);
    }

    if (!route.handlerFunction) continue;
    for (const ref of declaredSchemaRefs(route.handlerFunction)) {
      if (!actual.has(ref)) {
        findings.push(describeFinding(route, handlers, `declares ${ref} but it is missing from the operation`));
      } else if (!(ref.split('/').pop() as string in schemas)) {
        findings.push(describeFinding(route, handlers, `declares ${ref} but the schema is not defined`));
      }
    }
  }
  return sorted(findings);
}

/** Documented operations that no registered route serves, e.g. a wrong prefix. */
export function findUnservedOperations(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
): string[] {
  const served = new Set(routes.map(routeKey));
  return sorted(
    listDocumentedOperations(document)
      .filter((operation) => !served.has(routeKey(operation)))
      .map((operation) => `${routeKey(operation)} is documented but no route serves it`),
  );
}

/**
 * Method and path pairs registered by more than one handler. Express serves the
 * first one only, while the document can describe either.
 */
export function findDuplicateRoutes(routes: RegisteredRoute[]): string[] {
  const handlers = new Map<string, string[]>();
  for (const route of routes) {
    handlers.set(routeKey(route), [...(handlers.get(routeKey(route)) ?? []), route.handler]);
  }
  return sorted(
    [...handlers.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([key, owners]) => `${key} is registered by ${owners.join(', ')}`),
  );
}

/**
 * Allowlist entries that no longer earn their place: the route is gone, or it is
 * now documented and the entry only hides future drift.
 */
export function findStaleAllowlistEntries(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
  allowlist: AllowlistedRoute[],
): string[] {
  const served = new Set(routes.map(routeKey));
  const documented = new Set(listDocumentedOperations(document).map(routeKey));
  const findings: string[] = [];
  for (const entry of allowlist) {
    if (!entry.reason.trim()) {
      findings.push(`${routeKey(entry)} is allowlisted without a reason`);
    }
    if (!served.has(routeKey(entry))) {
      findings.push(`${routeKey(entry)} is allowlisted but no route serves it`);
    } else if (documented.has(routeKey(entry))) {
      findings.push(`${routeKey(entry)} is allowlisted but is documented; remove the entry`);
    }
  }
  return sorted(findings);
}

/**
 * The per-route documentation checks of {@link findRouteDocumentationGaps}.
 * Each kind is asserted by its own test in `src/openapi.spec.ts`, so each kind
 * of gap fails distinctly.
 */
export type RouteCheck =
  | 'path'
  | 'method'
  | 'summary'
  | 'tags'
  | 'requestBody'
  | 'clientError'
  | 'security'
  | 'publicSecurity';

/** One missing piece of documentation for one registered route. */
export interface RouteDocumentationGap {
  check: RouteCheck;
  route: RegisteredRoute;
  /** `Controller.handler (METHOD /path): what is missing`. */
  message: string;
}

export interface RouteDocumentationOptions {
  /** Routes deliberately left out of the document; no check applies to them. */
  allowlist?: AllowlistedRoute[];
  /** Documented routes that cannot answer with any 4xx; only the 4xx check skips them. */
  noClientErrorRoutes?: AllowlistedRoute[];
}

/** `AgentController.findOne (GET /api/v1/agents/{id})`: how a gap names its route. */
export function describeRoute(route: RegisteredRoute): string {
  return `${route.handler} (${routeKey(route)})`;
}

/** `400`-`499` or the OpenAPI `4XX` range. */
function isClientErrorStatus(status: string): boolean {
  return /^4(\d\d|XX)$/i.test(status);
}

/**
 * Checks every registered route against the document, route by route:
 *
 * - `path`: the path exists in the document,
 * - `method`: the path documents the route's HTTP method,
 * - `summary`: the operation has a non-empty summary,
 * - `tags`: the operation has at least one tag,
 * - `requestBody`: a handler that takes a `@Body()` documents a request body
 *   whose content has a schema (whatever the method; routes without `@Body()`,
 *   such as `POST /agents/{id}/pause`, need no body),
 * - `clientError`: at least one `4xx` response is documented,
 * - `security`: a guarded route (not `@Public()`) declares a security
 *   requirement, operation-level or inherited from the document, naming only
 *   schemes the document defines,
 * - `publicSecurity`: a `@Public()` route declares no security requirement.
 *
 * A route missing its path or method gets only that gap: there is no operation
 * to check further. Allowlisted routes are skipped entirely.
 */
export function findRouteDocumentationGaps(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
  options: RouteDocumentationOptions = {},
): RouteDocumentationGap[] {
  const allowed = new Set((options.allowlist ?? []).map(routeKey));
  const noClientError = new Set((options.noClientErrorRoutes ?? []).map(routeKey));
  const schemes = new Set(Object.keys(document.components?.securitySchemes ?? {}));
  const gaps: RouteDocumentationGap[] = [];

  for (const route of routes) {
    if (allowed.has(routeKey(route))) continue;
    const gap = (check: RouteCheck, missing: string) =>
      gaps.push({ check, route, message: `${describeRoute(route)}: ${missing}` });

    const item = document.paths?.[route.path] as PathItemObject | undefined;
    if (!item) {
      gap('path', `path ${route.path} is missing from the OpenAPI document`);
      continue;
    }
    const operation = item[route.method.toLowerCase() as (typeof OPERATION_METHODS)[number]] as
      | OperationObject
      | undefined;
    if (!operation) {
      gap('method', `method ${route.method} is not documented on ${route.path}`);
      continue;
    }

    if (typeof operation.summary !== 'string' || !operation.summary.trim()) {
      gap('summary', 'missing operation summary (@ApiOperation({ summary }))');
    }
    if (!Array.isArray(operation.tags) || operation.tags.length === 0) {
      gap('tags', 'missing tag (@ApiTags)');
    }
    if (route.acceptsBody) {
      const content = requestBodyOf(operation, document)?.content ?? {};
      const typed = Object.values(content).some(
        (media) => media.schema !== undefined && isNamedOrTypedSchema(document, media.schema),
      );
      if (!typed) gap('requestBody', 'takes a @Body() but documents no request body schema');
    }
    if (
      !noClientError.has(routeKey(route)) &&
      !Object.keys(operation.responses ?? {}).some(isClientErrorStatus)
    ) {
      gap('clientError', 'missing 4xx error response');
    }

    const named = (operation.security ?? document.security ?? []).flatMap((requirement) =>
      Object.keys(requirement),
    );
    if (route.isPublic) {
      if (named.length > 0) {
        gap('publicSecurity', `is @Public() but declares the security requirement '${named.join("', '")}'`);
      }
    } else if (named.length === 0) {
      gap('security', 'is guarded but declares no security requirement (@ApiBearerAuth / @ApiSecurity)');
    } else {
      for (const scheme of named.filter((name) => !schemes.has(name))) {
        gap('security', `declares the undefined security scheme '${scheme}'`);
      }
    }
  }

  return gaps.sort((left, right) => left.message.localeCompare(right.message));
}

/**
 * Entries of the 4xx exemption list that no longer earn their place: no reason,
 * no route, an undocumented route, or a route that now documents a 4xx.
 */
export function findStaleClientErrorExemptions(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
  exemptions: AllowlistedRoute[],
): string[] {
  const served = new Set(routes.map(routeKey));
  const documented = new Map(
    listDocumentedOperations(document).map((entry) => [routeKey(entry), entry.operation]),
  );
  const findings: string[] = [];
  for (const entry of exemptions) {
    if (!entry.reason.trim()) {
      findings.push(`${routeKey(entry)} is exempt from the 4xx check without a reason`);
    }
    const operation = documented.get(routeKey(entry));
    if (!served.has(routeKey(entry))) {
      findings.push(`${routeKey(entry)} is exempt from the 4xx check but no route serves it`);
    } else if (!operation) {
      findings.push(`${routeKey(entry)} is exempt from the 4xx check but is not documented`);
    } else if (Object.keys(operation.responses ?? {}).some(isClientErrorStatus)) {
      findings.push(`${routeKey(entry)} is exempt from the 4xx check but documents a 4xx; remove the entry`);
    }
  }
  return sorted(findings);
}

/** Operations without a 2xx response, or whose 2xx response has no schema. */
export function findOperationsWithoutSuccessSchema(
  document: OpenAPIObject,
  handlers: ReadonlyMap<string, string> = new Map(),
): string[] {
  const findings: string[] = [];
  for (const { method, path, operation } of listDocumentedOperations(document)) {
    const success = Object.entries(operation.responses ?? {}).filter(([status]) =>
      status.startsWith('2'),
    );
    if (success.length === 0) {
      findings.push(describeFinding({ method, path }, handlers, 'documents no 2xx response'));
      continue;
    }
    for (const [status, response] of success) {
      const content = (response as { content?: Record<string, { schema?: unknown }> }).content;
      const hasSchema = Object.values(content ?? {}).some((media) => media.schema !== undefined);
      if (!hasSchema) {
        findings.push(
          describeFinding({ method, path }, handlers, `(${status}) documents no response schema`),
        );
      }
    }
  }
  return sorted(findings);
}

/**
 * Operations that do not document a success response using the standard
 * `{ success, data, meta, requestId }` envelope (referencing `ApiEnvelopeDto` or
 * declaring the four envelope fields).
 */
export function findOperationsWithoutSuccessEnvelope(
  document: OpenAPIObject,
  handlers: ReadonlyMap<string, string> = new Map(),
  exclusions: ReadonlyArray<string> = [],
): string[] {
  const excludedSet = new Set(exclusions);
  const findings: string[] = [];

  for (const { method, path, operation } of listDocumentedOperations(document)) {
    if (excludedSet.has(path) || excludedSet.has(`${method} ${path}`)) {
      continue;
    }

    const successResponses = Object.entries(operation.responses ?? {}).filter(([status]) =>
      status.startsWith('2'),
    );

    if (successResponses.length === 0) {
      findings.push(
        describeFinding({ method, path }, handlers, 'documents no 2xx success response'),
      );
      continue;
    }

    const hasEnvelope = successResponses.some(([, response]) => {
      const content = (response as { content?: Record<string, { schema?: unknown }> })?.content;
      if (!content) return false;

      return Object.values(content).some((media) => {
        const schema = media?.schema;
        if (!schema) return false;

        const refs = collectRefs(schema);
        if (refs.has('#/components/schemas/ApiEnvelopeDto')) {
          return true;
        }

        const candidate = schema as {
          properties?: Record<string, unknown>;
          allOf?: Array<{ $ref?: string; properties?: Record<string, unknown> }>;
        };

        if (
          candidate.properties &&
          'success' in candidate.properties &&
          'data' in candidate.properties &&
          'meta' in candidate.properties &&
          'requestId' in candidate.properties
        ) {
          return true;
        }

        if (Array.isArray(candidate.allOf)) {
          const allProps = candidate.allOf.reduce<Record<string, unknown>>((acc, part) => {
            if (part.$ref?.endsWith('/ApiEnvelopeDto')) {
              acc['success'] = true;
              acc['data'] = true;
              acc['meta'] = true;
              acc['requestId'] = true;
            }
            if (part.properties) {
              Object.assign(acc, part.properties);
            }
            return acc;
          }, {});

          if (
            'success' in allProps &&
            'data' in allProps &&
            'meta' in allProps &&
            'requestId' in allProps
          ) {
            return true;
          }
        }

        return false;
      });
    });

    if (!hasEnvelope) {
      findings.push(
        describeFinding(
          { method, path },
          handlers,
          'does not declare a success response using the { success, data, meta, requestId } envelope',
        ),
      );
    }
  }

  return sorted(findings);
}

/**
 * Operations that document a request body without a usable schema: no content,
 * no schema for a media type, or a schema that is neither a `$ref` to a named
 * component nor a self-describing type. This catches `@ApiBody({})`-style
 * annotations that make an endpoint look documented while telling integrators
 * nothing about the payload.
 */
export function findOperationsWithUntypedRequestBody(document: OpenAPIObject): string[] {
  const findings: string[] = [];

  for (const { method, path, operation } of listDocumentedOperations(document)) {
    if (!operation.requestBody) continue;

    const requestBody = resolveRequestBody(document, operation.requestBody);
    if (!requestBody) {
      findings.push(`${method} ${path} references an unresolved request body`);
      continue;
    }

    const content = requestBody.content;
    if (!content || Object.keys(content).length === 0) {
      findings.push(`${method} ${path} documents a request body without content`);
      continue;
    }

    for (const [mediaType, media] of Object.entries(content)) {
      if (!media?.schema) {
        findings.push(
          `${method} ${path} (${mediaType}) documents a request body without a schema`,
        );
      } else if (!isNamedOrTypedSchema(document, media.schema)) {
        findings.push(
          `${method} ${path} (${mediaType}) documents an untyped request body schema`,
        );
      }
    }
  }

  return sorted(findings);
}

function resolveRequestBody(document: OpenAPIObject, body: unknown): { content?: Record<string, { schema?: unknown }> } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const ref = (body as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    return resolvePointer(document, ref) as { content?: Record<string, { schema?: unknown }> } | undefined;
  }
  return body as { content?: Record<string, { schema?: unknown }> };
}

function isNamedOrTypedSchema(document: OpenAPIObject, schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const candidate = schema as Record<string, unknown>;
  const ref = candidate.$ref;
  if (typeof ref === 'string') {
    if (ref.startsWith('#/components/schemas/')) return true;
    return resolvePointer(document, ref) !== undefined;
  }
  return ['type', 'properties', 'additionalProperties', 'items', 'oneOf', 'anyOf', 'allOf', 'enum', 'const'].some(
    (key) => candidate[key] !== undefined,
  );
}

/**
 * Authenticated operations that do not offer every scheme the authentication
 * guard really accepts. `JwtAuthGuard` runs the `jwt` and `api-key` strategies,
 * so a protected route is reachable with either credential and the document
 * must list both as alternatives.
 */
export function findOperationsMissingSecuritySchemes(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
  requiredSchemes: ReadonlyArray<string>,
  handlers: ReadonlyMap<string, string> = new Map(),
): string[] {
  const authenticated = new Set(routes.filter((route) => !route.isPublic).map(routeKey));
  const findings: string[] = [];

  for (const { method, path, operation } of listDocumentedOperations(document)) {
    if (!authenticated.has(`${method} ${path}`)) continue;
    const requirements = operation.security ?? document.security ?? [];
    const offered = new Set(requirements.flatMap((requirement) => Object.keys(requirement)));
    for (const scheme of requiredSchemes) {
      if (!offered.has(scheme)) {
        findings.push(
          describeFinding(
            { method, path },
            handlers,
            `accepts '${scheme}' but does not declare it as a security alternative`,
          ),
        );
      }
    }
  }
  return sorted(findings);
}

/**
 * Error responses whose body is spelled out inline instead of referencing a
 * shared component schema. Inline copies drift apart; the problem-details body
 * is identical for every failure and must be declared once.
 */
export function findInlineErrorSchemas(
  document: OpenAPIObject,
  handlers: ReadonlyMap<string, string> = new Map(),
  exclusions: ReadonlyArray<string> = [],
): string[] {
  const schemas = document.components?.schemas ?? {};
  const excluded = new Set(exclusions);
  const findings: string[] = [];

  for (const { method, path, operation } of listDocumentedOperations(document)) {
    if (excluded.has(`${method} ${path}`) || excluded.has(path)) continue;
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (!/^[45]/.test(status)) continue;
      const resolved = resolveResponse(document, response);
      const content = resolved?.content ?? {};
      for (const [mediaType, media] of Object.entries(content)) {
        const ref = (media?.schema as { $ref?: string } | undefined)?.$ref;
        const named = typeof ref === 'string' && ref.split('/').pop()! in schemas;
        if (!named) {
          findings.push(
            describeFinding(
              { method, path },
              handlers,
              `(${status} ${mediaType}) declares an inline error body instead of a shared component schema`,
            ),
          );
        }
      }
    }
  }
  return sorted(findings);
}

/** The error statuses every documented operation of a given kind must declare. */
export interface StandardErrorExpectations {
  /** Statuses required on every documented operation. */
  always: ReadonlyArray<number>;
  /** Statuses required on operations of authenticated routes. */
  authenticated: ReadonlyArray<number>;
  /** Statuses required on operations that accept a request body. */
  withBody: ReadonlyArray<number>;
  /**
   * Statuses required on operations whose path ends in a parameter, which
   * addresses one stored resource. A literal sub-path under a parameter
   * (`/audit/resources/{id}/timeline`) is a scoped collection or action and can
   * legitimately answer an empty result instead of 404.
   */
  withTrailingPathParam: ReadonlyArray<number>;
  /** Route keys or paths exempt from the check (probes, for example). */
  exclusions?: ReadonlyArray<string>;
}

/**
 * Operations missing one of the standard error responses their route can really
 * answer with: authentication and permission failures, the global rate limit,
 * validation of a request body, a missing addressed resource, and the catch-all
 * server error.
 */
export function findOperationsMissingStandardErrors(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
  expectations: StandardErrorExpectations,
  handlers: ReadonlyMap<string, string> = new Map(),
): string[] {
  const byKey = new Map(routes.map((route) => [routeKey(route), route]));
  const excluded = new Set(expectations.exclusions ?? []);
  const findings: string[] = [];

  for (const { method, path, operation } of listDocumentedOperations(document)) {
    const key = `${method} ${path}`;
    if (excluded.has(key) || excluded.has(path)) continue;
    const route = byKey.get(key);
    if (!route) continue;

    const required = new Set<number>(expectations.always);
    if (!route.isPublic) expectations.authenticated.forEach((status) => required.add(status));
    if (route.acceptsBody) expectations.withBody.forEach((status) => required.add(status));
    if (/\/\{[^}]+\}$/.test(path)) {
      expectations.withTrailingPathParam.forEach((status) => required.add(status));
    }

    const documented = new Set(Object.keys(operation.responses ?? {}));
    for (const status of [...required].sort((a, b) => a - b)) {
      if (!documented.has(String(status))) {
        findings.push(
          describeFinding({ method, path }, handlers, `does not document the ${status} error response`),
        );
      }
    }
  }
  return sorted(findings);
}

/**
 * Component schemas that re-declare the `{ success, data, meta, requestId }`
 * envelope instead of composing `ApiEnvelopeDto`. Exactly one component may own
 * that shape.
 */
export function findDuplicateEnvelopeComponents(
  document: OpenAPIObject,
  envelopeComponent = 'ApiEnvelopeDto',
): string[] {
  const findings: string[] = [];
  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    if (name === envelopeComponent) continue;
    const properties = (schema as { properties?: Record<string, unknown> }).properties;
    if (!properties) continue;
    if (['success', 'data', 'meta', 'requestId'].every((field) => field in properties)) {
      findings.push(
        `components.schemas.${name} re-declares the response envelope; compose ${envelopeComponent} instead`,
      );
    }
  }
  return sorted(findings);
}

function resolveResponse(
  document: OpenAPIObject,
  response: unknown,
): { content?: Record<string, { schema?: unknown }> } | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const ref = (response as { $ref?: unknown }).$ref;
  if (typeof ref === 'string') {
    return resolvePointer(document, ref) as { content?: Record<string, { schema?: unknown }> } | undefined;
  }
  return response as { content?: Record<string, { schema?: unknown }> };
}

/**
 * `$ref`s that point at a schema the document does not define, each named with
 * where it appears (`GET /path` or `components.schemas.Name`).
 */
export function findDanglingRefs(
  document: OpenAPIObject,
  handlers: ReadonlyMap<string, string> = new Map(),
): string[] {
  const schemas = document.components?.schemas ?? {};
  const findings = new Set<string>();
  const check = (where: string, node: unknown) => {
    for (const ref of collectRefs(node)) {
      if (ref.startsWith('#/components/schemas/') && !(ref.split('/').pop() as string in schemas)) {
        findings.add(`${where} references the missing schema ${ref}`);
      } else if (ref.startsWith('#/') && !ref.startsWith('#/components/schemas/')) {
        if (resolvePointer(document, ref) === undefined) {
          findings.add(`${where} references the missing component ${ref}`);
        }
      }
    }
  };

  for (const documented of listDocumentedOperations(document)) {
    check(describeFinding(documented, handlers, ''), documented.operation);
  }
  for (const [name, schema] of Object.entries(schemas)) {
    check(`components.schemas.${name}`, schema);
  }
  for (const [kind, entries] of Object.entries(document.components ?? {})) {
    if (kind === 'schemas' || !entries || typeof entries !== 'object') continue;
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      check(`components.${kind}.${name}`, entry);
    }
  }
  return sorted([...findings]);
}

/** Every `$ref` string below `node`. */
export function collectRefs(node: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((entry) => collectRefs(entry, refs));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') {
        refs.add(value);
      } else {
        collectRefs(value, refs);
      }
    }
  }
  return refs;
}

function resolvePointer(document: OpenAPIObject, ref: string): unknown {
  let node: unknown = document;
  for (const segment of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}
