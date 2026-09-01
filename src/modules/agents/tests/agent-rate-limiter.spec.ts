import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRateLimiterGuard } from '../guards/agent-rate-limiter.guard';
import { AgentService } from '../agent.service';
import { DomainException } from '../../../common/exceptions/domain.exception';

vi.mock('ioredis', () => {
  return {
    Redis: vi.fn().mockImplementation(() => {
      const mockMulti = {
        zremrangebyscore: vi.fn().mockReturnThis(),
        zcard: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
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

describe('AgentRateLimiterGuard', () => {
  let guard: AgentRateLimiterGuard;
  let mockConfigService: Partial<ConfigService>;
  let mockAgentService: Partial<AgentService>;

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
    const mockResponse = { setHeader: vi.fn() };
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ params: { id: 'agent-1' }, user: { organizationId: 'org-1' } }),
        getResponse: () => mockResponse,
      }),
    } as unknown as ExecutionContext;

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
      exec: vi.fn().mockResolvedValue([[null, 1], [null, 5], [null, 1], [null, 1]]),
    };
    (guard as unknown as { redis: { multi: () => typeof mockMulti } }).redis.multi = vi.fn(() => mockMulti);

    const mockResponse = { setHeader: vi.fn() };
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({ params: { id: 'agent-1' }, user: { organizationId: 'org-1' } }),
        getResponse: () => mockResponse,
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(mockContext)).rejects.toThrowError(DomainException);
    expect(mockResponse.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });
});
