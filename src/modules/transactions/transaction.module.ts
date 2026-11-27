import { Module } from '@nestjs/common';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { TransactionRepository } from './transaction.repository';
import { WalletModule } from '../wallets/wallet.module';
import { AgentModule } from '../agents/agent.module';
import { PolicyModule } from '../policies/policy.module';
import { RiskModule } from '../risk/risk.module';
import { BudgetModule } from '../budgets/budget.module';
import { SorobanSimulationService } from './services/soroban-simulation.service';
import { StellarSimulationService } from './services/stellar-simulation.service';
import { GasEstimationService } from './services/gas-estimation.service';
import { TransactionPreflightService } from './services/transaction-preflight.service';
import { StellarModule } from '../stellar/stellar.module';
import { SpendingLimitService } from './spending-limit.service';
import { SpendingLimitGuard } from './guards/spending-limit.guard';
import { BullModule } from '@nestjs/bullmq';
import { Queues } from '../../queues/queues.constants';
import { createQueueRegistrationOptions } from '../../queues/queue-policy';
import { TransactionWorker } from './workers/transaction.worker';
import { TransactionIdempotencyCleanupService } from './transaction-idempotency-cleanup.service';
import { TransactionIdempotencyStore } from './idempotency/transaction-idempotency.store';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { IDEMPOTENCY_STORE } from '../../common/interceptors/idempotency-store';
import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { ApprovalExpiryQueue } from '../../queues/approval-expiry.queue';

/**
 * Transaction pipeline module. Pulls together wallets, agents, policies, risk
 * and budgets to enforce governance on every payment. Stellar + events are
 * provided globally. Exports the service so the approvals module can execute an
 * approved proposal's transaction.
 *
 * IdempotencyModule is imported so IdempotencyService is available to both
 * TransactionService and IdempotencyInterceptor on the create route.
 */
@Module({
  imports: [
    WalletModule,
    AgentModule,
    PolicyModule,
    RiskModule,
    BudgetModule,
    StellarModule,
    IdempotencyModule,
    BullModule.registerQueue(
      // Transaction execution is retried with exponential backoff and jitter.
      // A job that still fails on its last attempt is dead-lettered by the
      // shared QueueFailureListener for manual review.
      createQueueRegistrationOptions(Queues.Transactions, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
      }),
    ),
    // Approval proposals are created here, so the delayed expiry job is
    // scheduled from this module (ApprovalModule imports it for cancellation).
    BullModule.registerQueue({ name: Queues.ApprovalSweep }),
  ],
  controllers: [TransactionController],
  providers: [
    TransactionService,
    TransactionRepository,
    SorobanSimulationService,
    StellarSimulationService,
    GasEstimationService,
    TransactionPreflightService,
    SpendingLimitService,
    SpendingLimitGuard,
    TransactionWorker,
    TransactionIdempotencyCleanupService,
    TransactionIdempotencyStore,
    IdempotencyInterceptor,
    { provide: IDEMPOTENCY_STORE, useExisting: TransactionIdempotencyStore },
    ApprovalExpiryQueue,
  ],
  exports: [TransactionService, ApprovalExpiryQueue, SorobanSimulationService, StellarSimulationService, GasEstimationService, SpendingLimitService],
})
export class TransactionModule {}
