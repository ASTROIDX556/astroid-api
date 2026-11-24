import { RequestMethod } from '@nestjs/common';
import { RouteInfo } from '@nestjs/common/interfaces';

/**
 * Routes served outside the global API prefix (e.g. `api/v1`).
 *
 * `/metrics` stays at a fixed, unversioned path for Prometheus scrape configs,
 * and the liveness/readiness probes are excluded for the same reason:
 * orchestrator and load-balancer probe paths must not change when the API
 * version does.
 *
 * Shared by `main.ts` and the OpenAPI check (`src/openapi.spec.ts`), so the
 * document that check verifies is built with the paths the API really serves.
 */
export const GLOBAL_PREFIX_EXCLUDED_ROUTES: RouteInfo[] = [
  { path: 'metrics', method: RequestMethod.GET },
  { path: 'health/live', method: RequestMethod.GET },
  { path: 'health/ready', method: RequestMethod.GET },
];
