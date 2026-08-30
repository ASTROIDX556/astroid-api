import { Module } from '@nestjs/common';
import { BalanceWorker } from './balance.worker';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';
import { AnalyticsAggregationWorker } from './analytics-aggregation.worker';
import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { WalletModule } from '../modules/wallets/wallet.module';

/**
 * Background job processors.
 *
 * Each worker owns one queue (see `@queues/*`) and isolates failures through
 * BullMQ retry + backoff so a flaky third-party (SMTP, Slack, webhook
 * consumer) never rolls back a financial action. Register workers here; they
 * are activated by the queue module once Redis is available.
 */
@Module({
  imports: [WalletModule],
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
