import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RedisHealthIndicator } from './redis.health';

const mockPing = vi.fn();
const mockConnect = vi.fn();

vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      status: 'ready',
      ping: mockPing,
      connect: mockConnect,
    })),
  };
});

describe('RedisHealthIndicator', () => {
  let indicator: RedisHealthIndicator;
  let configService: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    configService = {
      get: vi.fn().mockReturnValue({
        host: 'localhost',
        port: 6379,
      }),
    };
    indicator = new RedisHealthIndicator(configService as unknown as ConfigService);
  });

  it('returns up status when ping returns PONG', async () => {
    mockPing.mockResolvedValue('PONG');

    const report = await indicator.checkHealth();

    expect(report.status).toBe('up');
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toBeDefined();
    expect(report.error).toBeUndefined();
  });

  it('returns down status when ping rejects with an error', async () => {
    mockPing.mockRejectedValue(new Error('Redis connection lost'));

    const report = await indicator.checkHealth();

    expect(report.status).toBe('down');
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toBeDefined();
    expect(report.error).toBe('Redis connection lost');
  });

  it('returns down status when ping returns unexpected payload', async () => {
    mockPing.mockResolvedValue('NOPE');

    const report = await indicator.checkHealth();

    expect(report.status).toBe('down');
    expect(report.error).toContain('Unexpected Redis ping response: NOPE');
  });
});
