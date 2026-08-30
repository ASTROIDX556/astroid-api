import { Module } from '@nestjs/common';
import { QueueModule } from '../../queues/queue.module';
import { DlqController } from './dlq.controller';
import { DlqService } from './dlq.service';

/**
 * Administrative module providing secured operator controls over
 * background queues, dead-letter processing, and forensic error recovery.
 */
@Module({
  imports: [QueueModule],
  controllers: [DlqController],
  providers: [DlqService],
  exports: [DlqService],
})
export class AdminModule {}
