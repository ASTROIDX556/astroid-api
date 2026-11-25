import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsAccessGuard } from './metrics-access.guard';
import { WorkerMetricsService } from './worker-metrics.service';
import { StreamMetricsService } from './stream-metrics.service';

/**
 * Prometheus metrics module: HTTP duration/counter collection via the global
 * `MetricsInterceptor`, the `/metrics` scrape endpoint, worker job latency/
 * outcome tracking (`WorkerMetricsService`), and per-stream p95/p99 latency
 * aggregation (`StreamMetricsService`).
 *
 * All metric services are exported so workers and other modules can
 * record custom metrics against the shared Prometheus registry.
 */
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricsAccessGuard,
    WorkerMetricsService,
    StreamMetricsService,
  ],
  exports: [MetricsService, WorkerMetricsService, StreamMetricsService],
})
export class MetricsModule {}
