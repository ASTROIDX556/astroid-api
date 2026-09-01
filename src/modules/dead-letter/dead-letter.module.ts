import { Module } from '@nestjs/common';
import { DeadLetterController } from './dead-letter.controller';
import { DeadLetterService } from './dead-letter.service';

/**
 * Dead-letter queue (DLQ) module. Monitors every BullMQ queue for terminal job
 * failures, logs structured context, and persists them to the append-only
 * domain-event ledger for audit and administrative inspection/re-drive.
 */
@Module({
  controllers: [DeadLetterController],
  providers: [DeadLetterService],
  exports: [DeadLetterService],
})
export class DeadLetterModule {}