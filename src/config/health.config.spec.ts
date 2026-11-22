import { describe, expect, it } from 'vitest';
import { resolveHealthProbeConfig } from './health.config';

describe('resolveHealthProbeConfig', () => {
  it('defaults to a 1s check timeout and no caching', () => {
    expect(resolveHealthProbeConfig({})).toEqual({ checkTimeoutMs: 1_000, readinessCacheTtlMs: 0 });
  });

  it('reads both settings from the environment', () => {
    expect(
      resolveHealthProbeConfig({
        HEALTH_CHECK_TIMEOUT_MS: '1500',
        HEALTH_READINESS_CACHE_TTL_MS: '2000',
      }),
    ).toEqual({ checkTimeoutMs: 1_500, readinessCacheTtlMs: 2_000 });
  });

  it('falls back to the defaults for invalid or out-of-range values', () => {
    for (const bad of ['abc', '-1', '0', '1.5', '999999', '']) {
      expect(resolveHealthProbeConfig({ HEALTH_CHECK_TIMEOUT_MS: bad }).checkTimeoutMs).toBe(1_000);
    }
    for (const bad of ['abc', '-5', '2.5', '999999']) {
      expect(resolveHealthProbeConfig({ HEALTH_READINESS_CACHE_TTL_MS: bad }).readinessCacheTtlMs).toBe(0);
    }
  });

  it('accepts 0 to disable caching explicitly', () => {
    expect(resolveHealthProbeConfig({ HEALTH_READINESS_CACHE_TTL_MS: '0' }).readinessCacheTtlMs).toBe(0);
  });
});
