import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ApiKeyThrottlerGuard,
  API_KEY_THROTTLE_LIMIT_KEY,
  API_KEY_THROTTLE_TTL_KEY,
} from './api-key-throttler.guard';
import { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { API_KEY_HEADER } from '../constants/headers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock of ApiKeyService.verify() */
function mockApiKeyService(overrides: { verify?: ReturnType<typeof vi.fn> } = {}) {
  return {
    verify: overrides.verify ?? vi.fn(),
  } as any;
}

/** Build a mock ThrottlerStorage with an in-memory counter map. */
function mockStorage() {
  const store = new Map<string, { hits: number; createdAt: number }>();

  return {
    store,
    increment: vi.fn(
      async (
        key: string,
        _ttl: number,
        limit: number,
        _blockDuration: number,
        _throttlerName: string,
      ) => {
        const existing = store.get(key);
        const now = Date.now();
        if (!existing || now - existing.createdAt > _ttl) {
          store.set(key, { hits: 1, createdAt: now });
          return { totalHits: 1, timeToExpire: _ttl, isBlocked: false, timeToBlockExpire: 0 };
        }
        existing.hits += 1;
        const timeToExpire = _ttl - (now - existing.createdAt);
        const isBlocked = existing.hits > limit;
        return {
          totalHits: existing.hits,
          timeToExpire: Math.max(0, timeToExpire),
          isBlocked,
          timeToBlockExpire: isBlocked ? timeToExpire : 0,
        };
      },
    ),
  } as any;
}

function mockReflector(overrides: Record<string, any> = {}) {
  return {
    getAllAndOverride: vi.fn((key: string) => overrides[key] ?? undefined),
  } as any;
}

/** Fake Express request */
function fakeReq(
  headers: Record<string, string | string[]> = {},
  ip = '127.0.0.1',
) {
  return {
    headers,
    ip,
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
    get headers() { return headers; },
    header: vi.fn((k: string, v: string) => { headers[k] = String(v); }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as any;
}

/** Minimal ExecutionContext for HTTP requests */
function fakeContext(req: any, res: any): ExecutionContext {
  return {
    getHandler: () => () => {},
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getArgByIndex: vi.fn(),
    getArgs: vi.fn(),
    getType: () => 'http',
    switchToRpc: vi.fn(),
    switchToWs: vi.fn(),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiKeyThrottlerGuard', () => {
  let guard: ApiKeyThrottlerGuard;
  let storage: ReturnType<typeof mockStorage>;
  let reflector: ReturnType<typeof mockReflector>;
  let apiKeyService: ReturnType<typeof mockApiKeyService>;
  let req: any;
  let res: any;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
    reflector = mockReflector();
    apiKeyService = mockApiKeyService();

    guard = new ApiKeyThrottlerGuard(
      { throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }] } as any,
      storage,
      reflector,
      apiKeyService,
    );

    req = fakeReq();
    res = fakeRes();
  });

  // -----------------------------------------------------------------------
  // getTracker — API key extraction
  // -----------------------------------------------------------------------
  describe('getTracker()', () => {
    it('returns org:<id> when a valid x-api-key header is present', async () => {
      const orgId = 'org-abc-123';
      apiKeyService.verify.mockResolvedValue({ organizationId: orgId });
      req = fakeReq({ [API_KEY_HEADER]: 'ak_live_test123' });

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe(`org:${orgId}`);
      expect(apiKeyService.verify).toHaveBeenCalledWith('ak_live_test123');
    });

    it('extracts Bearer token from Authorization header when x-api-key is absent', async () => {
      const orgId = 'org-bearer-456';
      apiKeyService.verify.mockResolvedValue({ organizationId: orgId });
      req = fakeReq({ authorization: 'Bearer ak_live_bearer_token' });

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe(`org:${orgId}`);
      expect(apiKeyService.verify).toHaveBeenCalledWith('ak_live_bearer_token');
    });

    it('prefers x-api-key header over Authorization Bearer token', async () => {
      apiKeyService.verify.mockResolvedValue({ organizationId: 'org-primary' });
      req = fakeReq({
        [API_KEY_HEADER]: 'ak_live_primary',
        authorization: 'Bearer ak_live_secondary',
      });

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe('org:org-primary');
      expect(apiKeyService.verify).toHaveBeenCalledTimes(1);
      expect(apiKeyService.verify).toHaveBeenCalledWith('ak_live_primary');
    });

    it('falls back to IP tracking when no API key is present', async () => {
      req = fakeReq({}, '192.168.1.100');

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe('ip:192.168.1.100');
      expect(apiKeyService.verify).not.toHaveBeenCalled();
    });

    it('falls back to IP tracking when API key verification returns null', async () => {
      apiKeyService.verify.mockResolvedValue(null);
      req = fakeReq({ [API_KEY_HEADER]: 'ak_live_invalid' }, '10.0.0.1');

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe('ip:10.0.0.1');
    });

    it('falls back to IP when verification throws', async () => {
      apiKeyService.verify.mockRejectedValue(new Error('db timeout'));
      req = fakeReq({ [API_KEY_HEADER]: 'ak_live_error' }, '172.16.0.1');

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe('ip:172.16.0.1');
    });

    it('uses x-forwarded-for header for IP fallback when available', async () => {
      req = fakeReq({ 'x-forwarded-for': '203.0.113.50, 70.41.3.18' }, '127.0.0.1');

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe('ip:203.0.113.50');
    });

    it('returns "anonymous" when no IP information is available', async () => {
      req = { headers: {}, ip: undefined, socket: {} };

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe('ip:anonymous');
    });

    it('ignores Authorization header when scheme is not Bearer', async () => {
      req = fakeReq({ authorization: 'Basic dXNlcjpwYXNz' });

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe('ip:127.0.0.1');
      expect(apiKeyService.verify).not.toHaveBeenCalled();
    });

    it('ignores Authorization header when token part is empty', async () => {
      req = fakeReq({ authorization: 'Bearer ' });

      const tracker = await guard['getTracker'](req);

      expect(tracker).toBe('ip:127.0.0.1');
    });
  });

  // -----------------------------------------------------------------------
  // handleRequest — rate-limit enforcement
  // -----------------------------------------------------------------------
  describe('handleRequest()', () => {
    it('passes when under the limit and sets rate-limit headers', async () => {
      apiKeyService.verify.mockResolvedValue({ organizationId: 'org-1' });
      req = fakeReq({ [API_KEY_HEADER]: 'ak_live_test' });
      const ctx = fakeContext(req, res);

      const result = await (guard as any).handleRequest({
        context: ctx,
        limit: 100,
        ttl: 60_000,
        throttler: { name: 'default', ttl: 60_000, limit: 100 },
        blockDuration: 0,
        getTracker: guard['getTracker'].bind(guard),
        generateKey: guard['generateKey'].bind(guard),
      });

      expect(result).toBe(true);
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '99');
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Reset',
        expect.any(String),
      );
    });

    it('throws ThrottlerException when limit is exceeded', async () => {
      apiKeyService.verify.mockResolvedValue({ organizationId: 'org-2' });
      req = fakeReq({ [API_KEY_HEADER]: 'ak_live_burst' });
      const ctx = fakeContext(req, res);

      // Exhaust the limit
      for (let i = 0; i < 100; i++) {
        await (guard as any).handleRequest({
          context: ctx,
          limit: 100,
          ttl: 60_000,
          throttler: { name: 'default', ttl: 60_000, limit: 100 },
          blockDuration: 0,
          getTracker: guard['getTracker'].bind(guard),
          generateKey: guard['generateKey'].bind(guard),
        });
      }

      // 101st request should throw
      await expect(
        (guard as any).handleRequest({
          context: ctx,
          limit: 100,
          ttl: 60_000,
          throttler: { name: 'default', ttl: 60_000, limit: 100 },
          blockDuration: 0,
          getTracker: guard['getTracker'].bind(guard),
          generateKey: guard['generateKey'].bind(guard),
        }),
      ).rejects.toThrow(ThrottlerException);
    });

    it('skips enforcement for non-default throttler names', async () => {
      apiKeyService.verify.mockResolvedValue({ organizationId: 'org-3' });
      req = fakeReq({ [API_KEY_HEADER]: 'ak_live_skip' });
      const ctx = fakeContext(req, res);

      const result = await (guard as any).handleRequest({
        context: ctx,
        limit: 10,
        ttl: 60_000,
        throttler: { name: 'auth', ttl: 60_000, limit: 10 },
        blockDuration: 0,
        getTracker: guard['getTracker'].bind(guard),
        generateKey: guard['generateKey'].bind(guard),
      });

      expect(result).toBe(true);
      // Storage should NOT have been called
      expect(storage.increment).not.toHaveBeenCalled();
    });

    it('applies per-route limit override from metadata', async () => {
      apiKeyService.verify.mockResolvedValue({ organizationId: 'org-4' });
      req = fakeReq({ [API_KEY_HEADER]: 'ak_live_override' });
      reflector = mockReflector({
        [API_KEY_THROTTLE_LIMIT_KEY]: 500,
      });
      // Re-create guard with the new reflector
      guard = new ApiKeyThrottlerGuard(
        { throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }] } as any,
        storage,
        reflector,
        apiKeyService,
      );

      const ctx = fakeContext(req, res);

      await (guard as any).handleRequest({
        context: ctx,
        limit: 100,
        ttl: 60_000,
        throttler: { name: 'default', ttl: 60_000, limit: 100 },
        blockDuration: 0,
        getTracker: guard['getTracker'].bind(guard),
        generateKey: guard['generateKey'].bind(guard),
      });

      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '500');
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '499');
    });
  });

  // -----------------------------------------------------------------------
  // Independent org tracking
  // -----------------------------------------------------------------------
  describe('independent org tracking', () => {
    it('tracks different organizations independently', async () => {
      apiKeyService.verify.mockImplementation(async (key: string) => {
        if (key === 'ak_live_orgA') return { organizationId: 'org-A' };
        if (key === 'ak_live_orgB') return { organizationId: 'org-B' };
        return null;
      });

      // Exhaust org A
      const reqA = fakeReq({ [API_KEY_HEADER]: 'ak_live_orgA' });
      const resA = fakeRes();
      const ctxA = fakeContext(reqA, resA);

      for (let i = 0; i < 5; i++) {
        await (guard as any).handleRequest({
          context: ctxA,
          limit: 5,
          ttl: 60_000,
          throttler: { name: 'default', ttl: 60_000, limit: 5 },
          blockDuration: 0,
          getTracker: guard['getTracker'].bind(guard),
          generateKey: guard['generateKey'].bind(guard),
        });
      }

      // Org A should now be blocked on the 6th request
      await expect(
        (guard as any).handleRequest({
          context: ctxA,
          limit: 5,
          ttl: 60_000,
          throttler: { name: 'default', ttl: 60_000, limit: 5 },
          blockDuration: 0,
          getTracker: guard['getTracker'].bind(guard),
          generateKey: guard['generateKey'].bind(guard),
        }),
      ).rejects.toThrow(ThrottlerException);

      // Org B should still have a clean slate
      const reqB = fakeReq({ [API_KEY_HEADER]: 'ak_live_orgB' });
      const resB = fakeRes();
      const ctxB = fakeContext(reqB, resB);

      const result = await (guard as any).handleRequest({
        context: ctxB,
        limit: 5,
        ttl: 60_000,
        throttler: { name: 'default', ttl: 60_000, limit: 5 },
        blockDuration: 0,
        getTracker: guard['getTracker'].bind(guard),
        generateKey: guard['generateKey'].bind(guard),
      });

      expect(result).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // API key vs IP fallback tracking independence
  // -----------------------------------------------------------------------
  describe('api key vs ip fallback', () => {
    it('tracks API key requests separately from IP requests', async () => {
      apiKeyService.verify.mockResolvedValue({ organizationId: 'org-key' });

      // Exhaust the IP-based counter (no API key)
      const reqIp = fakeReq({}, '10.0.0.50');
      const resIp = fakeRes();
      const ctxIp = fakeContext(reqIp, resIp);

      for (let i = 0; i < 3; i++) {
        await (guard as any).handleRequest({
          context: ctxIp,
          limit: 3,
          ttl: 60_000,
          throttler: { name: 'default', ttl: 60_000, limit: 3 },
          blockDuration: 0,
          getTracker: guard['getTracker'].bind(guard),
          generateKey: guard['generateKey'].bind(guard),
        });
      }

      // IP tracker is now blocked
      await expect(
        (guard as any).handleRequest({
          context: ctxIp,
          limit: 3,
          ttl: 60_000,
          throttler: { name: 'default', ttl: 60_000, limit: 3 },
          blockDuration: 0,
          getTracker: guard['getTracker'].bind(guard),
          generateKey: guard['generateKey'].bind(guard),
        }),
      ).rejects.toThrow(ThrottlerException);

      // API key from same IP should still pass (different tracker key)
      const reqKey = fakeReq({ [API_KEY_HEADER]: 'ak_live_orgkey' }, '10.0.0.50');
      const resKey = fakeRes();
      const ctxKey = fakeContext(reqKey, resKey);

      const result = await (guard as any).handleRequest({
        context: ctxKey,
        limit: 3,
        ttl: 60_000,
        throttler: { name: 'default', ttl: 60_000, limit: 3 },
        blockDuration: 0,
        getTracker: guard['getTracker'].bind(guard),
        generateKey: guard['generateKey'].bind(guard),
      });

      expect(result).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Metadata keys export
  // -----------------------------------------------------------------------
  describe('metadata keys', () => {
    it('exports API_KEY_THROTTLE_LIMIT_KEY', () => {
      expect(API_KEY_THROTTLE_LIMIT_KEY).toBe('astroid:apiKeyThrottleLimit');
    });

    it('exports API_KEY_THROTTLE_TTL_KEY', () => {
      expect(API_KEY_THROTTLE_TTL_KEY).toBe('astroid:apiKeyThrottleTtl');
    });
  });

  // -----------------------------------------------------------------------
  // Error response format
  // -----------------------------------------------------------------------
  describe('throwThrottlingException()', () => {
    it('throws a ThrottlerException with structured message', async () => {
      await expect(
        (guard as any).throwThrottlingException({}),
      ).rejects.toThrow(ThrottlerException);
    });
  });

  // -----------------------------------------------------------------------
  // extractBearerToken (private)
  // -----------------------------------------------------------------------
  describe('extractBearerToken()', () => {
    it('extracts token from Bearer scheme', () => {
      const result = (guard as any).extractBearerToken({
        headers: { authorization: 'Bearer abc123' },
      });
      expect(result).toBe('abc123');
    });

    it('returns undefined for non-Bearer schemes', () => {
      const result = (guard as any).extractBearerToken({
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(result).toBeUndefined();
    });

    it('returns undefined when authorization header is missing', () => {
      const result = (guard as any).extractBearerToken({
        headers: {},
      });
      expect(result).toBeUndefined();
    });

    it('returns undefined when Bearer token is empty', () => {
      const result = (guard as any).extractBearerToken({
        headers: { authorization: 'Bearer ' },
      });
      expect(result).toBeUndefined();
    });
  });
});
