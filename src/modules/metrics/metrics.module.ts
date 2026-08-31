import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsAccessGuard } from './metrics-access.guard';
import { RequestMetricsMiddleware } from './metrics.middleware';
import { WorkerMetricsService } from './worker-metrics.service';

/**
 * Prometheus metrics module: HTTP duration/counter collection
 * (`RequestMetricsMiddleware`), the `/metrics` scrape endpoint,
 * and worker job latency/outcome tracking (`WorkerMetricsService`).
 *
 * Both `MetricsService` and `WorkerMetricsService` are exported so
 * workers and other modules can record custom metrics against the
 * shared Prometheus registry.
 */
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsAccessGuard, RequestMetricsMiddleware, WorkerMetricsService],
  exports: [MetricsService, WorkerMetricsService],
})
export class MetricsModule {}
