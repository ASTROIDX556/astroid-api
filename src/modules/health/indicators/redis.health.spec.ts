import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisHealthIndicator } from './redis.health';
import { ConfigService } from '@nestjs/config';

const mockPing = vi.fn();
vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      ping: mockPing,
    })),
  };
});

describe('RedisHealthIndicator', () => {
  let configService: Partial<ConfigService>;
  let indicator: RedisHealthIndicator;

  beforeEach(() => {
    vi.clearAllMocks();
    configService = {
      get: vi.fn().mockReturnValue('redis://localhost:6379'),
    };
    indicator = new RedisHealthIndicator(configService as ConfigService);
  });

  it('returns UP when ping returns PONG', async () => {
    mockPing.mockResolvedValue('PONG');

    const report = await indicator.checkHealth();

    expect(report.status).toBe('up');
    expect(report.latencyMs).toBeDefined();
    expect(report.error).toBeUndefined();
  });

  it('returns DOWN when ping fails', async () => {
    mockPing.mockRejectedValue(new Error('Redis connection refused'));

    const report = await indicator.checkHealth();

    expect(report.status).toBe('down');
    expect(report.error).toContain('Redis connection refused');
  });
});
