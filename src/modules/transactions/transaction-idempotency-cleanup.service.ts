import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TransactionRepository } from './transaction.repository';

@Injectable()
export class TransactionIdempotencyCleanupService {
  constructor(private readonly repository: TransactionRepository) {}

  @Cron(CronExpression.EVERY_HOUR)
  async removeExpiredRecords(): Promise<void> {
    await this.repository.deleteExpiredIdempotencyKeys();
  }
}