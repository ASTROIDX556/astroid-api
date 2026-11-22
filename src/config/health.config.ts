/**
 * Settings for the orchestrator health probes (`GET /health/ready`).
 *
 * Read straight from the environment (same approach as the rate-limit list
 * parsers) so an out-of-range value falls back to the default instead of
 * stopping the API from booting over a monitoring knob.
 */
export interface HealthProbeConfig {
  /** Ceiling on each readiness dependency check, in milliseconds. */
  checkTimeoutMs: number;
  /**
   * How long a readiness result is reused before the dependencies are probed
   * again, in milliseconds. `0` disables caching.
   */
  readinessCacheTtlMs: number;
}

export const HEALTH_CHECK_TIMEOUT_DEFAULT_MS = 1_000;
export const HEALTH_CHECK_TIMEOUT_MIN_MS = 50;
export const HEALTH_CHECK_TIMEOUT_MAX_MS = 10_000;

export const HEALTH_READINESS_CACHE_TTL_DEFAULT_MS = 0;
export const HEALTH_READINESS_CACHE_TTL_MAX_MS = 10_000;

function readBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * Resolves the probe settings:
 * - `HEALTH_CHECK_TIMEOUT_MS` (default 1000, 50-10000)
 * - `HEALTH_READINESS_CACHE_TTL_MS` (default 0 = off, 0-10000)
 */
export function resolveHealthProbeConfig(env: NodeJS.ProcessEnv = process.env): HealthProbeConfig {
  return {
    checkTimeoutMs: readBoundedInt(
      env.HEALTH_CHECK_TIMEOUT_MS,
      HEALTH_CHECK_TIMEOUT_DEFAULT_MS,
      HEALTH_CHECK_TIMEOUT_MIN_MS,
      HEALTH_CHECK_TIMEOUT_MAX_MS,
    ),
    readinessCacheTtlMs: readBoundedInt(
      env.HEALTH_READINESS_CACHE_TTL_MS,
      HEALTH_READINESS_CACHE_TTL_DEFAULT_MS,
      0,
      HEALTH_READINESS_CACHE_TTL_MAX_MS,
    ),
  };
}
