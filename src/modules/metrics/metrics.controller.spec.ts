import { describe, expect, it, vi } from 'vitest';
import { Response } from 'express';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

function buildResponse(): Response {
  const res: Partial<Response> = {};
  res.setHeader = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('MetricsController', () => {
  it('writes the Prometheus exposition body with the registry content type', async () => {
    const metricsService = {
      getMetrics: vi.fn().mockResolvedValue('http_requests_total 1\n'),
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
    } as unknown as MetricsService;
    const controller = new MetricsController(metricsService);
    const res = buildResponse();

    await controller.scrape(res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith('http_requests_total 1\n');
  });
});
