import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRateLimiterGuard } from '../guards/agent-rate-limiter.guard';
import { AgentService } from '../agent.service';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { ErrorCode } from '../../../common/constants/error-codes';

vi.mock('ioredis', () => {
  return {
    Redis: vi.fn().mockImplementation(() => {
      const mockMulti = {
        zremrangebyscore: vi.fn().mockReturnThis(),
        zcard: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        zrange: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[null, 1], [null, 2], [null, 1], [null, 1]]),
      };
      return {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
        multi: vi.fn(() => mockMulti),
      };
    }),
  };
});

/**
 * In-memory Redis double with an atomic `MULTI`/`EXEC`, so concurrent requests
 * cannot interleave inside a transaction — exactly like Redis.
 */
function createFakeRedis() {
  const windows = new Map<string, Map<string, number>>();

  const redis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
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

describe('AgentRateLimiterGuard', () => {
  let guard: AgentRateLimiterGuard;
  let mockConfigService: Partial<ConfigService>;
  let mockAgentService: Partial<AgentService>;

  const buildContext = () => {
    const mockResponse = { setHeader: vi.fn() };
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ params: { id: 'agent-1' }, user: { organizationId: 'org-1' } }),
        getResponse: () => mockResponse,
      }),
    } as unknown as ExecutionContext;
    return { mockContext, mockResponse };
  };

  beforeEach(() => {
    mockConfigService = {
      get: vi.fn().mockImplementation((_key, defaultValue) => defaultValue),
    };

    mockAgentService = {
      getOrThrow: vi.fn().mockResolvedValue({ metadata: { rateLimit: 5 } }),
    };

    guard = new AgentRateLimiterGuard(
      mockConfigService as ConfigService,
      mockAgentService as AgentService,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should allow request if under limit', async () => {
    const { mockContext, mockResponse } = buildContext();

    const result = await guard.canActivate(mockContext);
    expect(result).toBe(true);
    expect(mockResponse.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
  });

  it('should throw DomainException if limit exceeded', async () => {
    const mockMulti = {
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      zrange: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null, 1], [null, 5], [null, 1], [null, 1]]),
    };
    (guard as unknown as { redis: { multi: () => typeof mockMulti } }).redis.multi = vi.fn(() => mockMulti);

    const { mockContext, mockResponse } = buildContext();

    await expect(guard.canActivate(mockContext)).rejects.toThrowError(DomainException);
    expect(mockResponse.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });

  it('answers with the HTTP 429 status and a positive Retry-After', async () => {
    const { redis, windows } = createFakeRedis();
    (guard as unknown as { redis: unknown }).redis = redis;

    const { mockContext, mockResponse } = buildContext();

    // The agent metadata declares a limit of 5.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(guard.canActivate(mockContext)).resolves.toBe(true);
    }

    await expect(guard.canActivate(mockContext)).rejects.toMatchObject({
      status: 429,
      code: ErrorCode.RATE_LIMITED,
    });

    const retryAfter = mockResponse.setHeader.mock.calls.find(
      (call: unknown[]) => call[0] === 'Retry-After',
    )?.[1] as number;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(windows.size).toBe(1);
  });

  it('allows exactly the limit of concurrent requests and rejects the rest', async () => {
    const { redis } = createFakeRedis();
    (guard as unknown as { redis: unknown }).redis = redis;
    mockAgentService.getOrThrow = vi.fn().mockResolvedValue({ metadata: { rateLimit: 3 } });

    const { mockContext } = buildContext();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => guard.canActivate(mockContext)),
    );

    const allowed = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(allowed).toHaveLength(3);
    expect(rejected).toHaveLength(5);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        status: 429,
        code: ErrorCode.RATE_LIMITED,
      });
    }
  });

  it('keeps the window of each agent separate', async () => {
    const { redis, windows } = createFakeRedis();
    (guard as unknown as { redis: unknown }).redis = redis;

    const contextFor = (agentId: string) => {
      const mockResponse = { setHeader: vi.fn() };
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({ params: { id: agentId }, user: { organizationId: 'org-1' } }),
          getResponse: () => mockResponse,
        }),
      } as unknown as ExecutionContext;
      return mockContext;
    };

    await guard.canActivate(contextFor('agent-1'));
    await guard.canActivate(contextFor('agent-2'));

    expect(windows.size).toBe(2);
  });
});
