import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookRepository } from './webhook.repository';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhookWorker } from './workers/webhook.worker';
import { WebhookRetryPolicy } from './webhook-retry.policy';
import { Queues } from '../../queues/queues.constants';
import { redisConfig } from '../../config/redis.config';
import {
  WEBHOOK_BACKOFF_TYPE,
  loadWebhookRetrySettings,
} from '../../config/webhook.config';

const retrySettings = loadWebhookRetrySettings();

/**
 * Webhooks module. The dispatcher listens to domain events and queues
 * the curated WEBHOOK_EVENTS set to subscribed external endpoints via BullMQ.
 * Deliveries retry with a capped, jittered backoff and are dead-lettered onto
 * `Queues.WebhookDeadLetter` once they fail permanently (#550).
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
    BullModule.registerQueue({
      name: Queues.Webhooks,
      defaultJobOptions: {
        attempts: retrySettings.maxAttempts,
        backoff: { type: WEBHOOK_BACKOFF_TYPE },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    }),
    BullModule.registerQueue({
      name: Queues.WebhookDeadLetter,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookRepository,
    WebhookDispatcher,
    WebhookDeliveryService,
    WebhookWorker,
    {
      provide: WebhookRetryPolicy,
      useFactory: () => new WebhookRetryPolicy(loadWebhookRetrySettings()),
    },
  ],
  exports: [WebhookService],
})
export class WebhookModule {}
