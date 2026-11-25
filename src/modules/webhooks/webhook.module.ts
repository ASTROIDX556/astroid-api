import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { WebhookController } from './webhook.controller';
import { WebhookDlqController } from './webhook-dlq.controller';
import { WebhookIngressController } from './webhook-ingress.controller';
import { WebhookIngressService } from './webhook-ingress.service';
import { WebhookService } from './webhook.service';
import { WebhookRepository } from './webhook.repository';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhookAuditService } from './services/webhook-audit.service';
import { WebhookAttemptService } from './services/webhook-attempt.service';
import { WebhookDeadLetterService } from './services/webhook-dead-letter.service';
import { PrismaWebhookDlqStore } from './services/webhook-dlq.store';
import { WebhookDlqDispatcher } from './services/webhook-dlq.dispatcher';
import { WebhookDlqService } from './services/webhook-dlq.service';
import { WebhookCircuitService } from './services/webhook-circuit.service';
import { WebhooksProcessor } from './webhooks.processor';
import { createWebhookQueueOptions } from '../../queues/webhook.queue';
import { Queues } from '../../queues/queues.constants';
import { redisConfig } from '../../config/redis.config';
import { WebhookConfig } from '../../config/webhook.config';
import { MetricsModule } from '../metrics/metrics.module';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { EncryptionModule } from '../../common/encryption/encryption.module';
import { WebhookSignatureGuard } from '../../common/guards/webhook-signature.guard';
import { SlidingWindowThrottlerGuard } from '../../common/guards/sliding-window-throttler.guard';
import { WebhookDestinationPolicy } from './webhook-destination.policy';

/**
 * Webhooks module. The dispatcher listens to domain events and queues the
 * curated WEBHOOK_EVENTS set to subscribed external endpoints via BullMQ.
 *
 * Retry policy (attempts, exponential backoff with jitter and a maximum
 * delay) and the dead-letter routing live in `@queues/webhook.queue`, so the
 * API and the worker can never drift apart. The queue is registered from the
 * resolved configuration, so the operator's values apply. `WebhookAuditService`
 * records deliveries that exhaust their retries in the compliance audit trail,
 * and `WebhookCircuitService` pauses the deliveries of an endpoint that keeps
 * failing.
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
    BullModule.registerQueueAsync({
      name: Queues.Webhooks,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createWebhookQueueOptions(config.getOrThrow<WebhookConfig>('webhook')),
    }),
    // The delivery worker routes exhausted deliveries onto the shared
    // dead-letter queue, so this module needs the queue handle too.
    BullModule.registerQueue({ name: Queues.DeadLetter }),
    MetricsModule,
    IdempotencyModule,
    EncryptionModule,
  ],
  controllers: [WebhookDlqController, WebhookController, WebhookIngressController],
  providers: [
    WebhookService,
    WebhookDestinationPolicy,
    WebhookRepository,
    WebhookDispatcher,
    WebhookDeliveryService,
    WebhookAuditService,
    WebhookAttemptService,
    WebhookDeadLetterService,
    PrismaWebhookDlqStore,
    WebhookDlqDispatcher,
    {
      provide: WebhookDlqService,
      inject: [PrismaWebhookDlqStore, WebhookDlqDispatcher],
      useFactory: (store: PrismaWebhookDlqStore, dispatcher: WebhookDlqDispatcher) =>
        new WebhookDlqService(store, dispatcher),
    },
    WebhookCircuitService,
    WebhooksProcessor,
    WebhookIngressService,
    WebhookSignatureGuard,
    SlidingWindowThrottlerGuard,
  ],
  exports: [WebhookService],
})
export class WebhookModule {}
