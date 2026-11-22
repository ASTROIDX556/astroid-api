import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';
import { redisConfig } from '../../config/redis.config';
import { MetricsModule } from '../metrics/metrics.module';
import { WalletModule } from './wallet.module';
import { WalletReconciliationService } from './services/wallet-reconciliation.service';
import { WalletReconciliationWorker } from '../../workers/wallet-reconciliation.worker';
import { WalletReconciliationScheduler } from '../../workers/wallet-reconciliation.scheduler';

/**
 * Scheduled Stellar wallet reconciliation.
 *
 * Owns the `wallet-reconciliation` queue, its repeatable scheduler and the
 * BullMQ processor. Horizon access goes through the global Stellar module's
 * `StellarService`, so this module never talks to the network directly.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      ...createQueueRegistrationOptions(Queues.WalletReconciliation, {
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
    WalletModule,
    MetricsModule,
  ],
  providers: [
    WalletReconciliationService,
    WalletReconciliationWorker,
    WalletReconciliationScheduler,
  ],
  exports: [WalletReconciliationService, WalletReconciliationScheduler],
})
export class WalletReconciliationModule {}
