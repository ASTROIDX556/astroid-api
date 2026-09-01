import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';
import { normalizeRoutePath } from '../../utils/route-normalizer.util';

/**
 * Records HTTP request duration and status-code counters for every request.
 * The `/metrics` endpoint itself is excluded so scraping doesn't skew its
 * own histogram.
 */
@Injectable()
export class RequestMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metricsService: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (req.path === '/metrics') {
      next();
      return;
    }

    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = normalizeRoutePath(req.path);
      this.metricsService.observeHttpRequest(req.method, route, res.statusCode, durationSeconds);
    });

    next();
  }
}
