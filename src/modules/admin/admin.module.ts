import { Module } from '@nestjs/common';
import { QueueModule } from '../../queues/queue.module';
import { DlqController } from './dlq.controller';
import { DlqService } from './dlq.service';
import { QueueManagementController } from './queue-management.controller';
import { QueueManagementService } from './queue-management.service';

/**
 * Administrative module providing secured operator controls over
 * background queues, dead-letter processing, and forensic error recovery.
 */
@Module({
  imports: [QueueModule],
  controllers: [DlqController, QueueManagementController],
  providers: [DlqService, QueueManagementService],
  exports: [DlqService, QueueManagementService],
})
export class AdminModule {}
