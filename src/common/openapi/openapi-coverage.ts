import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ApplicationConfig, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { RoutePathFactory } from '@nestjs/core/router/route-path-factory';
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

/** Registered routes with no operation in the document and no allowlist entry. */
export function findUndocumentedRoutes(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
  allowlist: AllowlistedRoute[] = [],
): string[] {
  const documented = new Set(listDocumentedOperations(document).map(routeKey));
  const allowed = new Set(allowlist.map(routeKey));
  return sorted(
    routes
      .filter((route) => !documented.has(routeKey(route)) && !allowed.has(routeKey(route)))
      .map((route) => `${routeKey(route)} (${route.handler}) is not in the OpenAPI document`),
  );
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

/** Operations without a 2xx response, or whose 2xx response has no schema. */
export function findOperationsWithoutSuccessSchema(document: OpenAPIObject): string[] {
  const findings: string[] = [];
  for (const { method, path, operation } of listDocumentedOperations(document)) {
    const success = Object.entries(operation.responses ?? {}).filter(([status]) =>
      status.startsWith('2'),
    );
    if (success.length === 0) {
      findings.push(`${method} ${path} documents no 2xx response`);
      continue;
    }
    for (const [status, response] of success) {
      const content = (response as { content?: Record<string, { schema?: unknown }> }).content;
      const hasSchema = Object.values(content ?? {}).some((media) => media.schema !== undefined);
      if (!hasSchema) {
        findings.push(`${method} ${path} (${status}) documents no response schema`);
      }
    }
  }
  return sorted(findings);
}

/**
 * Documented operations of authenticated routes that declare no security
 * requirement, or one naming a scheme the document does not define.
 */
export function findOperationsMissingSecurity(
  routes: RegisteredRoute[],
  document: OpenAPIObject,
): string[] {
  const authenticated = new Set(routes.filter((route) => !route.isPublic).map(routeKey));
  const schemes = new Set(Object.keys(document.components?.securitySchemes ?? {}));
  const findings: string[] = [];

  for (const { method, path, operation } of listDocumentedOperations(document)) {
    if (!authenticated.has(`${method} ${path}`)) continue;
    const requirements = operation.security ?? document.security ?? [];
    const named = requirements.flatMap((requirement) => Object.keys(requirement));
    if (named.length === 0) {
      findings.push(`${method} ${path} requires authentication but declares no security scheme`);
      continue;
    }
    for (const scheme of named.filter((name) => !schemes.has(name))) {
      findings.push(`${method} ${path} declares the undefined security scheme '${scheme}'`);
    }
  }
  return sorted(findings);
}

/**
 * `$ref`s that point at a schema the document does not define, each named with
 * where it appears (`GET /path` or `components.schemas.Name`).
 */
export function findDanglingRefs(document: OpenAPIObject): string[] {
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

  for (const { method, path, operation } of listDocumentedOperations(document)) {
    check(`${method} ${path}`, operation);
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
