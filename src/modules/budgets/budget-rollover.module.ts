import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';
import { redisConfig } from '../../config/redis.config';
import { MetricsModule } from '../metrics/metrics.module';
import { BudgetPeriodRepository } from './budget-period.repository';
import { BudgetRolloverService } from './services/budget-rollover.service';
import { BudgetRolloverWorker } from '../../workers/budget-rollover.worker';
import { BudgetRolloverScheduler } from '../../workers/budget-rollover.scheduler';

/**
 * Scheduled fixed-period budget rollover. Owns its queue, repeatable scheduler
 * and processor; the period math itself lives in a pure utility so it can be
 * tested without Redis or Postgres.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      ...createQueueRegistrationOptions(Queues.BudgetRollover, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      }),
      connection: {
        host: redisConfig().host,
        port: redisConfig().port,
        password: redisConfig().password,
        db: redisConfig().db,
      },
    }),
    MetricsModule,
  ],
  providers: [
    BudgetPeriodRepository,
    BudgetRolloverService,
    BudgetRolloverWorker,
    BudgetRolloverScheduler,
  ],
  exports: [BudgetRolloverService, BudgetRolloverScheduler],
})
export class BudgetRolloverModule {}
