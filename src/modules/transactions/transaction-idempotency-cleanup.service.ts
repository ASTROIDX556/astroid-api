import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';

@Injectable()
export class TransactionIdempotencyCleanupService {
  constructor(private readonly idempotency: IdempotencyService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async removeExpiredRecords(): Promise<void> {
    await this.idempotency.deleteExpired();
  }
}
