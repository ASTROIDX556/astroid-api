import { Module } from '@nestjs/common';
import { BalanceWorker } from './balance.worker';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';
import { AnalyticsAggregationWorker } from './analytics-aggregation.worker';
import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { WalletModule } from '../modules/wallets/wallet.module';
import { MetricsModule } from '../modules/metrics/metrics.module';

/**
 * Background job processors.
 *
 * Each worker owns one queue (see `@queues/*`) and isolates failures through
 * BullMQ retry + backoff so a flaky third-party (SMTP, Slack, webhook
 * consumer) never rolls back a financial action. Register workers here; they
 * are activated by the queue module once Redis is available.
 *
 * Workers inject `WorkerMetricsService` from the MetricsModule to record
 * processing latency and outcomes against the Prometheus registry. This is
 * completely optional — workers that don't inject it simply won't emit
 * `worker_job_duration_seconds` or `worker_jobs_total` metrics.
 */
@Module({
  imports: [WalletModule, MetricsModule],
  providers: [
    NotificationDeliveryWorker,
    WebhookDeliveryWorker,
    BalanceWorker,
    AnalyticsAggregationWorker,
  ],
  exports: [
    NotificationDeliveryWorker,
    WebhookDeliveryWorker,
    BalanceWorker,
    AnalyticsAggregationWorker,
  ],
})
export class WorkersModule {}
