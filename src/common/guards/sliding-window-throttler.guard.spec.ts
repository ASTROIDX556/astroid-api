import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ErrorCode } from '../constants/error-codes';
import { SlidingWindowThrottlerGuard } from './sliding-window-throttler.guard';

const exec = vi.fn();
const chain = {
  zremrangebyscore: vi.fn().mockReturnThis(),
  zcard: vi.fn().mockReturnThis(),
  zadd: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  zrange: vi.fn().mockReturnThis(),
  exec,
};

function makeContext(
  user?: Record<string, unknown>,
  ip = '127.0.0.1',
  headers: Record<string, string> = {},
  body?: Record<string, unknown>,
  params?: Record<string, unknown>,
) {
  const response = { setHeader: vi.fn() };
  const request = { user, ip, headers, body, params };
  const handler = vi.fn();
  const context = {
    getHandler: () => handler,
    getClass: () => class AgentController {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  };
  return { context, response, request };
}

function makeGuard(redis: Record<string, unknown>, limit = 2) {
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };
  const config = {
    get: vi.fn((key: string, fallback: unknown) =>
      key === 'rateLimit.maxRequests' ? limit : fallback,
    ),
  };
  const guard = new SlidingWindowThrottlerGuard(reflector as never, config as never);
  Object.assign(guard, { redis });
  return guard;
}

/**
 * In-memory Redis double. `MULTI`/`EXEC` is atomic, so the queued commands are
 * applied in one synchronous batch — exactly like Redis, where concurrent
 * requests cannot interleave inside a transaction.
 */
function createFakeRedis() {
  const windows = new Map<string, Map<string, number>>();

  const redis = {
    multi: () => {
      const queued: Array<() => unknown> = [];
      const fake = {
        zremrangebyscore: vi.fn((key: string, min: number, max: number) => {
          queued.push(() => {
            const members = windows.get(key);
            if (!members) return 0;
            let removed = 0;
            for (const [member, score] of members) {
              if (score >= min && score <= max) {
                members.delete(member);
                removed += 1;
              }
            }
            return removed;
          });
          return fake;
        }),
        zcard: vi.fn((key: string) => {
          queued.push(() => windows.get(key)?.size ?? 0);
          return fake;
        }),
        zadd: vi.fn((key: string, score: number, member: string) => {
          queued.push(() => {
            const members = windows.get(key) ?? new Map<string, number>();
            members.set(member, score);
            windows.set(key, members);
            return 1;
          });
          return fake;
        }),
        expire: vi.fn(() => {
          queued.push(() => 1);
          return fake;
        }),
        zrange: vi.fn((key: string, _start: number, _stop: number, withScores?: string) => {
          queued.push(() => {
            const members = windows.get(key);
            if (!members || members.size === 0) return [];
            const oldest = [...members.entries()].sort((left, right) => left[1] - right[1])[0];
            return withScores === 'WITHSCORES' ? [oldest[0], String(oldest[1])] : [oldest[0]];
          });
          return fake;
        }),
        exec: vi.fn(async () => {
          const results = queued.map((command) => [null, command()] as [null, unknown]);
          queued.length = 0;
          return results;
        }),
      };
      return fake;
    },
  };

  return { redis, windows };
}

describe('SlidingWindowThrottlerGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exec.mockResolvedValue([
      [null, 0],
      [null, 0],
      [null, 1],
      [null, 1],
    ]);
  });

  it('allows requests and emits standard rate-limit headers', async () => {
    const { context, response } = makeContext({ organizationId: 'org-1' });
    const guard = makeGuard({ multi: () => chain });
    expect(await guard.canActivate(context as never)).toBe(true);
    expect(chain.zremrangebyscore).toHaveBeenCalled();
    expect(chain.zcard).toHaveBeenCalled();
    expect(chain.zadd).toHaveBeenCalled();
    expect(chain.expire).toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 2);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 1);
  });

  it('rejects an exhausted window with Retry-After', async () => {
    exec.mockResolvedValue([
      [null, 0],
      [null, 2],
      [null, 1],
      [null, 1],
    ]);
    const { context, response } = makeContext({ organizationId: 'org-1' });
    const guard = makeGuard({ multi: () => chain });
    await expect(guard.canActivate(context as never)).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
    });
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });

  it('answers with the HTTP 429 status when the limit is exceeded', async () => {
    exec.mockResolvedValue([
      [null, 0],
      [null, 5],
      [null, 1],
      [null, 1],
    ]);
    const { context } = makeContext({ organizationId: 'org-1' });
    const guard = makeGuard({ multi: () => chain });

    await expect(guard.canActivate(context as never)).rejects.toMatchObject({
      status: 429,
      code: ErrorCode.RATE_LIMITED,
    });
  });

  it('uses organization scope for authenticated users and IP scope otherwise', async () => {
    const redis = { multi: vi.fn(() => chain) };
    const authenticated = makeContext({ organizationId: 'org-1' });
    const anonymous = makeContext(undefined, '192.0.2.1');
    const guard = makeGuard(redis);
    await guard.canActivate(authenticated.context as never);
    await guard.canActivate(anonymous.context as never);
    expect(chain.zadd.mock.calls[0][1]).toBeGreaterThan(0);
    expect(redis.multi).toHaveBeenCalledTimes(2);
  });

  it('uses the authenticated API key ID instead of its organization for throttling', async () => {
    const { context } = makeContext({
      organizationId: 'org-1',
      apiKeyId: 'key-1',
      isApiKey: true,
    });
    const guard = makeGuard({ multi: () => chain });

    await guard.canActivate(context as never);

    expect(chain.zremrangebyscore.mock.calls[0][0]).toContain(':key:key-1:');
  });

  it('falls back to a hashed API key scope when unauthenticated but keyed', async () => {
    const redis = { multi: vi.fn(() => chain) };
    const withApiKey = makeContext(undefined, '192.0.2.1', { 'x-api-key': 'ast_secret-key' });
    const anonymous = makeContext(undefined, '192.0.2.1');
    const guard = makeGuard(redis);
    await guard.canActivate(withApiKey.context as never);
    await guard.canActivate(anonymous.context as never);
    expect(redis.multi).toHaveBeenCalledTimes(2);
  });

  it('fails open and logs when Redis is unavailable', async () => {
    const logger = { error: vi.fn() };
    const { context, response } = makeContext({ organizationId: 'org-1' });
    const guard = makeGuard({
      multi: () => {
        throw new Error('offline');
      },
    });
    Object.assign(guard, { logger });
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('allowing request'));
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 2);
  });

  it('supports enterprise tier dynamic limits', async () => {
    const { context, response } = makeContext({ organizationId: 'org-ent', tier: 'enterprise' });
    const guard = makeGuard({ multi: () => chain }, 100);
    expect(await guard.canActivate(context as never)).toBe(true);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 500);
  });

  it('supports pro tier dynamic limits', async () => {
    const { context, response } = makeContext({ organizationId: 'org-pro', tier: 'pro' });
    const guard = makeGuard({ multi: () => chain }, 100);
    expect(await guard.canActivate(context as never)).toBe(true);
    expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 250);
  });

  // ── Per-agent bucketing ──────────────────────────────────────────────────

  it('buckets the window per acting agent so agents do not share a budget', async () => {
    const { redis, windows } = createFakeRedis();
    const guard = makeGuard(redis, 1);
    const agentA = makeContext({ organizationId: 'org-1' }, '127.0.0.1', {}, { agentId: 'agent-a' });
    const agentB = makeContext({ organizationId: 'org-1' }, '127.0.0.1', {}, { agentId: 'agent-b' });

    await expect(guard.canActivate(agentA.context as never)).resolves.toBe(true);
    await expect(guard.canActivate(agentB.context as never)).resolves.toBe(true);

    // Each agent has its own window, so neither exhausts the other.
    expect(windows.size).toBe(2);
    for (const key of windows.keys()) {
      expect(key).toContain(':agent:');
    }
  });

  it('rejects a repeated request of the same agent once its window is exhausted', async () => {
    const { redis } = createFakeRedis();
    const guard = makeGuard(redis, 1);
    const agent = makeContext({ organizationId: 'org-1' }, '127.0.0.1', {}, { agentId: 'agent-a' });

    await expect(guard.canActivate(agent.context as never)).resolves.toBe(true);
    await expect(guard.canActivate(agent.context as never)).rejects.toMatchObject({
      status: 429,
      code: ErrorCode.RATE_LIMITED,
    });
  });

  it('derives the acting agent from the route params and the agent header', async () => {
    const { redis, windows } = createFakeRedis();
    const guard = makeGuard(redis, 5);
    const byParam = makeContext({ organizationId: 'org-1' }, '127.0.0.1', {}, undefined, {
      agentId: 'agent-a',
    });
    const byHeader = makeContext({ organizationId: 'org-1' }, '127.0.0.1', {
      'x-agent-id': 'agent-b',
    });

    await guard.canActivate(byParam.context as never);
    await guard.canActivate(byHeader.context as never);

    const keys = [...windows.keys()];
    expect(keys.some((key) => key.includes(':agent:agent-a:'))).toBe(true);
    expect(keys.some((key) => key.includes(':agent:agent-b:'))).toBe(true);
  });

  // ── Retry-After ──────────────────────────────────────────────────────────

  it('reports the time until the oldest request leaves the window', async () => {
    const { redis } = createFakeRedis();
    const guard = makeGuard(redis, 1);
    const { context, response } = makeContext({ organizationId: 'org-1' });

    await guard.canActivate(context as never);
    await expect(guard.canActivate(context as never)).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
    });

    const retryAfter = response.setHeader.mock.calls.find(
      (call: unknown[]) => call[0] === 'Retry-After',
    )?.[1] as number;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  // ── Concurrency ──────────────────────────────────────────────────────────

  it('allows exactly the limit of concurrent requests and rejects the rest', async () => {
    const { redis } = createFakeRedis();
    const guard = makeGuard(redis, 3);
    const { context } = makeContext({ organizationId: 'org-1' });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => guard.canActivate(context as never)),
    );

    const allowed = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(allowed).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        status: 429,
        code: ErrorCode.RATE_LIMITED,
      });
    }
  });

  it('keeps concurrent requests of different agents independent', async () => {
    const { redis } = createFakeRedis();
    const guard = makeGuard(redis, 2);
    const agentA = makeContext({ organizationId: 'org-1' }, '127.0.0.1', {}, { agentId: 'agent-a' });
    const agentB = makeContext({ organizationId: 'org-1' }, '127.0.0.1', {}, { agentId: 'agent-b' });

    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => guard.canActivate(agentA.context as never)),
      ...Array.from({ length: 4 }, () => guard.canActivate(agentB.context as never)),
    ]);

    const allowed = results.filter((result) => result.status === 'fulfilled');
    expect(allowed).toHaveLength(4);
  });
});
