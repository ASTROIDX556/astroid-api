import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AstroidThrottlerGuard } from './throttler.guard';

function createGuard(): AstroidThrottlerGuard {
  const config = {
    getOrThrow: () => ({
      throttle: {
        apiLimit: 120,
        authLimit: 10,
        webhookLimit: 30,
        ttl: 60,
        apiBurst: 10,
        authBurst: 3,
        webhookBurst: 5,
      },
    }),
  };
  const guard = new AstroidThrottlerGuard(config as unknown as ConfigService);
  // Inject mock reflector
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (guard as any).reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(undefined),
  };
  return guard;
}

/** Call the protected handleRequest via prototype access. */
async function callHandleRequest(guard: AstroidThrottlerGuard, requestProps: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (guard as any).handleRequest(requestProps);
}

function mockRequestProps(throttlerName: string, overrides?: { setHeader?: ReturnType<typeof vi.fn> }) {
  const setHeader = overrides?.setHeader ?? vi.fn();
  return {
    context: {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: { organizationId: 'org-1' }, ip: '127.0.0.1', headers: {} }),
        getResponse: () => ({ setHeader }),
      }),
    },
    throttler: { name: throttlerName, ttl: 60000, limit: 120 },
    limit: 120,
    ttl: 60000,
    key: `org:org-1`,
  };
}

describe('AstroidThrottlerGuard', () => {
  let guard: AstroidThrottlerGuard;

  beforeEach(() => {
    guard = createGuard();
    // Default reflector to return 'api' tier for all routes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (guard as any).reflector = {
      getAllAndOverride: vi.fn().mockReturnValue('api'),
    };
  });

  it('allows requests when the throttler name matches the route tier', async () => {
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);

    const result = await callHandleRequest(guard, mockRequestProps('api'));
    expect(result).toBe(true);
  });

  it('skips counting when throttler name does not match route tier', async () => {
    // Reflects 'api' tier but throttler name is 'auth' → should skip
    const result = await callHandleRequest(guard, mockRequestProps('auth'));
    expect(result).toBe(true);
  });

  it('defaults to api tier when reflector returns undefined', async () => {
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (guard as any).reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    };

    const result = await callHandleRequest(guard, mockRequestProps('api'));
    expect(result).toBe(true);
  });

  it('sets X-RateLimit-Limit header on allowed requests', async () => {
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);

    const setHeader = vi.fn();
    const result = await callHandleRequest(guard, mockRequestProps('api', { setHeader }));
    expect(result).toBe(true);
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 120);
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));
  });

  it('sets Retry-After header when parent guard rejects', async () => {
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(false);

    const setHeader = vi.fn();
    await callHandleRequest(guard, mockRequestProps('api', { setHeader }));
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });

  describe('burst limiting', () => {
    it('allows the first request in a burst window', async () => {
      vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (guard as any).reflector = {
        getAllAndOverride: vi.fn().mockReturnValue('auth'),
      };

      const result = await callHandleRequest(guard, mockRequestProps('auth'));
      expect(result).toBe(true);
    });

    it('rejects requests exceeding the burst limit within 1 second', async () => {
      vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (guard as any).reflector = {
        getAllAndOverride: vi.fn().mockReturnValue('auth'),
      };

      // Auth burst limit is 3 — send 4 requests rapidly
      for (let i = 0; i < 3; i++) {
        await callHandleRequest(guard, mockRequestProps('auth'));
      }
      // 4th request should be burst-exceeded
      const result = await callHandleRequest(guard, mockRequestProps('auth'));
      expect(result).toBe(false);
    });
  });

  describe('getTracker', () => {
    it('returns org-scoped tracker when user is authenticated', async () => {
      const req = { user: { organizationId: 'org-42' }, ip: '10.0.0.1', headers: {} };
      const tracker = await guard['getTracker'](req);
      expect(tracker).toBe('org:org-42');
    });

    it('falls back to IP tracker for anonymous requests', async () => {
      const req = { ip: '192.168.1.1', headers: {} };
      const tracker = await guard['getTracker'](req);
      expect(tracker).toBe('ip:192.168.1.1');
    });

    it('uses x-forwarded-for header when available', async () => {
      const req = { ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.50' } };
      const tracker = await guard['getTracker'](req);
      expect(tracker).toBe('ip:203.0.113.50');
    });
  });
});
