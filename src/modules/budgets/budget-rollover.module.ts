import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';
import { redisConfig } from '../../config/redis.config';
import { MetricsModule } from '../metrics/metrics.module';
import { BudgetModule } from './budget.module';
import { BudgetRolloverWorker } from '../../workers/budget-rollover.worker';
import { BudgetRolloverScheduler } from '../../workers/budget-rollover.scheduler';

/**
 * Scheduled fixed-period budget rollover. Owns its queue, repeatable scheduler
 * and processor; the period math itself lives in a pure utility so it can be
 * tested without Redis or Postgres. The rollover service itself is provided
 * by BudgetModule, which also uses it for reservations made after a boundary.
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
    BudgetModule,
  ],
  providers: [
    BudgetRolloverWorker,
    BudgetRolloverScheduler,
  ],
  exports: [BudgetModule, BudgetRolloverScheduler],
})
export class BudgetRolloverModule {}
