import { describe, expect, it, vi } from 'vitest';
import { WorkerMetricsService } from './worker-metrics.service';
import { MetricsService } from './metrics.service';

function buildMetricsService(): MetricsService {
  return { recordJobCompletion: vi.fn() } as unknown as MetricsService;
}

describe('WorkerMetricsService', () => {
  it('records success metrics when job completes', async () => {
    const metricsService = buildMetricsService();
    const workerMetrics = new WorkerMetricsService(metricsService);

    const result = await workerMetrics.instrumentJob('webhooks', 'deliver', async () => {
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(metricsService.recordJobCompletion).toHaveBeenCalledWith(
      'webhooks',
      'deliver',
      expect.any(Number),
      'success',
    );
  });

  it('records failure metrics when job throws', async () => {
    const metricsService = buildMetricsService();
    const workerMetrics = new WorkerMetricsService(metricsService);

    await expect(
      workerMetrics.instrumentJob('transactions', 'execute', async () => {
        throw new Error('insufficient funds');
      }),
    ).rejects.toThrow('insufficient funds');

    expect(metricsService.recordJobCompletion).toHaveBeenCalledWith(
      'transactions',
      'execute',
      expect.any(Number),
      'failure',
    );
  });

  it('re-throws the original error after recording failure', async () => {
    const metricsService = buildMetricsService();
    const workerMetrics = new WorkerMetricsService(metricsService);
    const originalError = new TypeError('bad payload');

    await expect(
      workerMetrics.instrumentJob('notifications', 'send', async () => {
        throw originalError;
      }),
    ).rejects.toThrow(originalError);
  });

  it('records positive duration for successful jobs', async () => {
    const metricsService = buildMetricsService();
    const workerMetrics = new WorkerMetricsService(metricsService);

    await workerMetrics.instrumentJob('analytics', 'rollup', async () => {
      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 10));
      return undefined;
    });

    const call = (metricsService.recordJobCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toBeGreaterThan(0);
  });
});
