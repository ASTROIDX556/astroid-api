import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThrottlerStorage } from '@nestjs/throttler';

import { createThrottlerOptions, throttlerConfig, ThrottlerConfig } from './throttler.config';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('throttlerConfig', () => {
  it('falls back to the documented defaults when no THROTTLE_* variable is set', () => {
    delete process.env.THROTTLE_TTL;
    delete process.env.THROTTLE_API_LIMIT;
    delete process.env.THROTTLE_AUTH_LIMIT;

    expect(throttlerConfig() as ThrottlerConfig).toEqual({
      windowSeconds: 60,
      apiLimit: 120,
      authLimit: 10,
    });
  });

  it('reads overrides from the THROTTLE_* environment variables', () => {
    process.env.THROTTLE_TTL = '30';
    process.env.THROTTLE_API_LIMIT = '500';
    process.env.THROTTLE_AUTH_LIMIT = '5';

    expect(throttlerConfig() as ThrottlerConfig).toEqual({
      windowSeconds: 30,
      apiLimit: 500,
      authLimit: 5,
    });
  });

  it('rejects a non-numeric THROTTLE_TTL instead of booting with a broken limit', () => {
    process.env.THROTTLE_TTL = 'not-a-number';

    expect(() => throttlerConfig()).toThrow(/THROTTLE_TTL/);
  });
});

describe('createThrottlerOptions', () => {
  const config: ThrottlerConfig = { windowSeconds: 60, apiLimit: 120, authLimit: 10 };

  it('exposes exactly two named tiers so AstroidThrottlerGuard can route by tier', () => {
    const options = createThrottlerOptions(config);

    expect(Array.isArray(options)).toBe(false);
    expect(options.throttlers.map((throttler) => throttler.name)).toEqual(['api', 'auth']);
  });

  it('converts the configured window from seconds to the milliseconds @nestjs/throttler expects', () => {
    const options = createThrottlerOptions({ ...config, windowSeconds: 30 });

    expect(options.throttlers[0].ttl).toBe(30_000);
    expect(options.throttlers[1].ttl).toBe(30_000);
  });

  it('applies the stricter limit to the auth tier only', () => {
    const options = createThrottlerOptions(config);

    expect(options.throttlers.find((t) => t.name === 'api')?.limit).toBe(120);
    expect(options.throttlers.find((t) => t.name === 'auth')?.limit).toBe(10);
  });

  it('attaches the shared Redis storage, without which counters stay in-process', () => {
    const storage = { increment: vi.fn() } as unknown as ThrottlerStorage;

    const options = createThrottlerOptions(config, storage);

    expect(options.storage).toBe(storage);
  });

  it('omits the storage key when none is supplied so the default is used', () => {
    const options = createThrottlerOptions(config);

    expect(options).not.toHaveProperty('storage');
  });
});
