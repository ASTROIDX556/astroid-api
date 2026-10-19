import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationRepository } from './notification.repository';
import { NotificationListener } from './notification.listener';
import { BullModule } from '@nestjs/bullmq';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';

/**
 * Notifications module. The listener converts domain events into in-app
 * notifications; the service + controller expose them to the dashboard.
 */
@Module({
  imports: [BullModule.registerQueue(createQueueRegistrationOptions(Queues.Notifications))],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationRepository, NotificationListener],
  exports: [NotificationService],
})
export class NotificationModule {}
