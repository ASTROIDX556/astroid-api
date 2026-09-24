import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisHealthIndicator } from './redis.health';
import Redis from 'ioredis';

describe('RedisHealthIndicator', () => {
  let redis: { ping: ReturnType<typeof vi.fn> };
  let indicator: RedisHealthIndicator;

  beforeEach(() => {
    redis = { ping: vi.fn() };
    indicator = new RedisHealthIndicator(redis as unknown as Redis);
  });

  it('returns UP when ping returns PONG', async () => {
    redis.ping.mockResolvedValue('PONG');
    const report = await indicator.checkHealth();
    expect(report.status).toBe('up');
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns DOWN when ping throws error', async () => {
    redis.ping.mockRejectedValue(new Error('Connection refused'));
    const report = await indicator.checkHealth();
    expect(report.status).toBe('down');
    expect(report.error).toContain('Connection refused');
  });
});
