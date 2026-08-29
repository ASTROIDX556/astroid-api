import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookRepository } from './webhook.repository';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhookWorker } from './workers/webhook.worker';
import { Queues } from '../../queues/queues.constants';
import { redisConfig } from '../../config/redis.config';

/**
 * Webhooks module. The dispatcher listens to domain events and queues
 * the curated WEBHOOK_EVENTS set to subscribed external endpoints via BullMQ.
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
    }),
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookRepository,
    WebhookDispatcher,
    WebhookDeliveryService,
    WebhookWorker,
  ],
  exports: [WebhookService],
})
export class WebhookModule {}
