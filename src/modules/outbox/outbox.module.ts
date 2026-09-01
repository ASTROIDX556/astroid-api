import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.registerQueue({
      name: 'outbox-events',
    }),
  ],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
