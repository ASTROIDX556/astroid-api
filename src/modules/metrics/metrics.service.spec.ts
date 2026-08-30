import { beforeEach, describe, expect, it, vi } from 'vitest';

const getJobCounts = vi.fn();
const close = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    getJobCounts,
    close,
  })),
}));

vi.mock('../../config/redis.config', () => ({
  redisConfig: () => ({ host: 'localhost', port: 6379, password: '', db: 0 }),
}));

import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    vi.clearAllMocks();
    getJobCounts.mockResolvedValue({
      waiting: 3,
      active: 1,
      completed: 100,
      failed: 2,
      delayed: 0,
      paused: 0,
    });
    service = new MetricsService();
  });

  it('exposes the Prometheus content type', () => {
    expect(service.contentType).toContain('text/plain');
  });

  it('records HTTP request duration and count', async () => {
    service.observeHttpRequest('GET', '/v1/agents/:id', 200, 0.042);

    const output = await service.getMetrics();

    expect(output).toContain('http_requests_total');
    expect(output).toContain('method="GET"');
    expect(output).toContain('route="/v1/agents/:id"');
    expect(output).toContain('status_code="200"');
    expect(output).toContain('http_request_duration_seconds');
  });

  it('accumulates counts across multiple requests with the same labels', async () => {
    service.observeHttpRequest('POST', '/v1/transactions', 201, 0.01);
    service.observeHttpRequest('POST', '/v1/transactions', 201, 0.02);

    const output = await service.getMetrics();
    const match = output.match(
      /http_requests_total\{method="POST",route="\/v1\/transactions",status_code="201"\} (\d+)/,
    );

    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('2');
  });

  it('samples BullMQ job counts per queue into the queue depth gauge', async () => {
    const output = await service.getMetrics();

    expect(getJobCounts).toHaveBeenCalled();
    expect(output).toContain('bullmq_queue_jobs');
    expect(output).toMatch(/bullmq_queue_jobs\{queue="webhooks",state="waiting"\} 3/);
    expect(output).toMatch(/bullmq_queue_jobs\{queue="webhooks",state="failed"\} 2/);
  });

  it('does not throw when a queue fails to report job counts', async () => {
    getJobCounts.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(service.getMetrics()).resolves.toEqual(expect.any(String));
  });

  it('closes all queue handles on module destroy', async () => {
    await service.onModuleDestroy();

    expect(close).toHaveBeenCalled();
  });
});
