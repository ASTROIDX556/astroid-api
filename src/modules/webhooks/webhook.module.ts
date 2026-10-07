import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhookController } from './webhook.controller';
import { WebhookIngressController } from './webhook-ingress.controller';
import { WebhookIngressService } from './webhook-ingress.service';
import { WebhookService } from './webhook.service';
import { WebhookRepository } from './webhook.repository';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhookAuditService } from './services/webhook-audit.service';
import { WebhooksProcessor } from './webhooks.processor';
import { createWebhookQueueOptions } from '../../queues/webhook.queue';
import { redisConfig } from '../../config/redis.config';
import { MetricsModule } from '../metrics/metrics.module';
import { RawBodyMiddleware } from '../../common/middleware/raw-body.middleware';
import { WebhookSignatureGuard } from '../../common/guards/webhook-signature.guard';
import { SlidingWindowThrottlerGuard } from '../../common/guards/sliding-window-throttler.guard';

/**
 * Webhooks module. The dispatcher listens to domain events and queues the
 * curated WEBHOOK_EVENTS set to subscribed external endpoints via BullMQ.
 *
 * Retry policy (5 attempts, exponential backoff with jitter) and the
 * dead-letter routing live in `@queues/webhook.queue`, so the API and the worker
 * can never drift apart. `WebhookAuditService` records deliveries that exhaust
 * their retries in the compliance audit trail.
 */
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: redisConfig().host,
        port: redisConfig().port,
        password: redisConfig().password,
        db: redisConfig().db,
      },
    }),
    BullModule.registerQueue(createWebhookQueueOptions()),
    MetricsModule,
  ],
  controllers: [WebhookController, WebhookIngressController],
  providers: [
    WebhookService,
    WebhookRepository,
    WebhookDispatcher,
    WebhookDeliveryService,
    WebhookAuditService,
    WebhooksProcessor,
    WebhookIngressService,
    WebhookSignatureGuard,
    SlidingWindowThrottlerGuard,
  ],
  exports: [WebhookService],
})
export class WebhookModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RawBodyMiddleware)
      .forRoutes({ path: 'webhooks/receive', method: RequestMethod.POST });
  }
}
