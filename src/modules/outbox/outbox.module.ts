import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.registerQueue(createQueueRegistrationOptions(Queues.OutboxEvents)),
  ],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
