import { describe, expect, it, vi } from 'vitest';
import { Request, Response } from 'express';
import { RequestMetricsMiddleware } from './metrics.middleware';
import { MetricsService } from './metrics.service';

function buildResponse(): Response {
  const listeners: Record<string, () => void> = {};
  return {
    statusCode: 200,
    on: (event: string, cb: () => void) => {
      listeners[event] = cb;
      return undefined as unknown as Response;
    },
    emit: (event: string) => listeners[event]?.(),
  } as unknown as Response;
}

describe('RequestMetricsMiddleware', () => {
  it('records duration and status code once the response finishes', () => {
    const metricsService = { observeHttpRequest: vi.fn() } as unknown as MetricsService;
    const middleware = new RequestMetricsMiddleware(metricsService);
    const req = { path: '/v1/agents/550e8400-e29b-41d4-a716-446655440000', method: 'GET' } as Request;
    const res = buildResponse();
    const next = vi.fn();

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalled();

    (res as unknown as { emit: (e: string) => void }).emit('finish');

    expect(metricsService.observeHttpRequest).toHaveBeenCalledWith(
      'GET',
      '/v1/agents/:id',
      200,
      expect.any(Number),
    );
  });

  it('does not instrument the /metrics scrape endpoint', () => {
    const metricsService = { observeHttpRequest: vi.fn() } as unknown as MetricsService;
    const middleware = new RequestMetricsMiddleware(metricsService);
    const req = { path: '/metrics', method: 'GET' } as Request;
    const res = buildResponse();
    const next = vi.fn();

    middleware.use(req, res, next);
    (res as unknown as { emit: (e: string) => void }).emit('finish');

    expect(next).toHaveBeenCalled();
    expect(metricsService.observeHttpRequest).not.toHaveBeenCalled();
  });
});
