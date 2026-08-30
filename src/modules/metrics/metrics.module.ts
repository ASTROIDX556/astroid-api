import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsAccessGuard } from './metrics-access.guard';
import { RequestMetricsMiddleware } from './metrics.middleware';

/**
 * Prometheus metrics module: HTTP duration/counter collection
 * (`RequestMetricsMiddleware`) and the `/metrics` scrape endpoint.
 * `MetricsService` is exported so other modules (e.g. workers) could record
 * custom metrics against the same registry in the future.
 */
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsAccessGuard, RequestMetricsMiddleware],
  exports: [MetricsService],
})
export class MetricsModule {}
