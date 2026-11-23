import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueObservabilityController } from './queue-observability.controller';
import { QueueObservabilityService } from './queue-observability.service';
import { redisConfig } from '../../config/redis.config';
import { Queues } from '../../queues/queues.constants';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: redisConfig().host,
        port: redisConfig().port,
        password: redisConfig().password,
        db: redisConfig().db,
      },
    }),
    BullModule.registerQueue({
      name: Queues.Webhooks,
    }),
    BullModule.registerQueue({
      name: Queues.Notifications,
    }),
    BullModule.registerQueue({
      name: Queues.StellarSync,
    }),
    BullModule.registerQueue({
      name: Queues.WalletReconciliation,
    }),
    BullModule.registerQueue({
      name: Queues.Analytics,
    }),
    BullModule.registerQueue({
      name: Queues.Reports,
    }),
    BullModule.registerQueue({
      name: Queues.OutboxEvents,
    }),
    BullModule.registerQueue({
      name: Queues.StellarFeeBump,
    }),
    BullModule.registerQueue({
      name: Queues.Transactions,
    }),
    BullModule.registerQueue({
      name: Queues.RiskAnalysis,
    }),
    BullModule.registerQueue({
      name: Queues.DeadLetter,
    }),
    BullModule.registerQueue({
      name: Queues.AuditCleanup,
    }),
    BullModule.registerQueue({
      name: Queues.AuditArchive,
    }),
    BullModule.registerQueue({
      name: Queues.BudgetRollover,
    }),
    BullModule.registerQueue({
      name: Queues.IdempotencyCleanup,
    }),
    BullModule.registerQueue({
      name: Queues.ApprovalSweep,
    }),
  ],
  controllers: [QueueObservabilityController],
  providers: [
    QueueObservabilityService,
  ],
  exports: [QueueObservabilityService],
})
export class QueueObservabilityModule {}