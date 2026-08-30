import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AstroidThrottlerGuard } from './throttler.guard';

/** Minimal mock for ThrottlerRequest used by handleRequest. */
function mockThrottlerRequest(throttlerName: string) {
  return {
    context: {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: { organizationId: 'org-1' }, ip: '127.0.0.1', headers: {} }),
        getResponse: () => ({ setHeader: vi.fn() }),
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
    guard = new AstroidThrottlerGuard(config as unknown as ConfigService);
    // Inject a mock reflector via the prototype chain
    (guard as Record<string, unknown>).reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(undefined),
    };
  });

  it('allows requests when the throttler name matches the route tier', async () => {
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);

    const requestProps = mockThrottlerRequest('api');
    const result = await (guard as Record<string, unknown>).handleRequest(requestProps);
    expect(result).toBe(true);
  });

  it('skips counting when throttler name does not match route tier', async () => {
    const requestProps = mockThrottlerRequest('auth');
    const result = await (guard as Record<string, unknown>).handleRequest(requestProps);
    expect(result).toBe(true);
  });

  it('defaults to api tier when no tier decorator is set', async () => {
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);

    const requestProps = mockThrottlerRequest('api');
    const result = await (guard as Record<string, unknown>).handleRequest(requestProps);
    expect(result).toBe(true);
  });

  it('sets X-RateLimit-Limit header on allowed requests', async () => {
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);

    const setHeader = vi.fn();
    const requestProps = {
      ...mockThrottlerRequest('api'),
      context: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({ user: { organizationId: 'org-1' }, ip: '127.0.0.1', headers: {} }),
          getResponse: () => ({ setHeader }),
        }),
      },
    };

    await (guard as Record<string, unknown>).handleRequest(requestProps);
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 120);
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));
  });

  it('sets Retry-After header when parent guard rejects', async () => {
    vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(false);

    const setHeader = vi.fn();
    const requestProps = {
      ...mockThrottlerRequest('api'),
      context: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({
          getRequest: () => ({ user: { organizationId: 'org-1' }, ip: '127.0.0.1', headers: {} }),
          getResponse: () => ({ setHeader }),
        }),
      },
    };

    await (guard as Record<string, unknown>).handleRequest(requestProps);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });

  describe('burst limiting', () => {
    it('allows the first request in a burst window', async () => {
      vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);

      const requestProps = mockThrottlerRequest('auth');
      const result = await (guard as Record<string, unknown>).handleRequest(requestProps);
      expect(result).toBe(true);
    });

    it('rejects requests exceeding the burst limit within 1 second', async () => {
      vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'handleRequest').mockResolvedValue(true);

      const requestProps = mockThrottlerRequest('auth');
      // Auth burst limit is 3 — send 4 requests rapidly
      for (let i = 0; i < 3; i++) {
        await (guard as Record<string, unknown>).handleRequest(requestProps);
      }
      // 4th request should be burst-exceeded
      const result = await (guard as Record<string, unknown>).handleRequest(requestProps);
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
