import { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { QueueHealthIndicator } from './queue.health';

/** A queue whose `client` promise resolves to a Redis client answering `ping`. */
function queueWith(ping: () => Promise<string>) {
  const client = { ping: vi.fn(ping) };
  const queue = { client: Promise.resolve(client) } as unknown as Queue;
  return { queue, client };
}

describe('QueueHealthIndicator', () => {
  it('reports up when the queue connection answers PING', async () => {
    const { queue, client } = queueWith(async () => 'PONG');

    const report = await new QueueHealthIndicator(queue).checkHealth();

    expect(report.status).toBe('up');
    expect(report.error).toBeUndefined();
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(client.ping).toHaveBeenCalledTimes(1);
  });

  it('probes the queue’s existing connection on every call instead of opening a new one', async () => {
    const { queue, client } = queueWith(async () => 'PONG');
    const indicator = new QueueHealthIndicator(queue);

    await indicator.checkHealth();
    await indicator.checkHealth();

    expect(client.ping).toHaveBeenCalledTimes(2);
  });

  it('reports down with a fixed message when the connection fails, never the raw error', async () => {
    const { queue } = queueWith(async () => {
      throw new Error('connect ECONNREFUSED 10.0.3.9:6379 (password=hunter2)');
    });

    const report = await new QueueHealthIndicator(queue).checkHealth();

    expect(report.status).toBe('down');
    expect(report.error).toBe('Queue connection unavailable');
  });

  it('reports down when the queue never obtains a client', async () => {
    const queue = { client: Promise.reject(new Error('redis://:secret@redis.internal:6379')) } as unknown as Queue;

    const report = await new QueueHealthIndicator(queue).checkHealth();

    expect(report.status).toBe('down');
    expect(report.error).toBe('Queue connection unavailable');
  });

  it('is bounded by the timeout when the connection hangs', async () => {
    const { queue } = queueWith(() => new Promise<string>(() => undefined));

    const startedAt = Date.now();
    const report = await new QueueHealthIndicator(queue).checkHealth(25);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(report).toMatchObject({
      status: 'down',
      error: 'Queue health check timed out after 25ms',
    });
  });

  it('reports down on an unexpected reply', async () => {
    const { queue } = queueWith(async () => 'LOADING');

    const report = await new QueueHealthIndicator(queue).checkHealth();

    expect(report.status).toBe('down');
  });
});
