import { Module } from '@nestjs/common';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { TransactionRepository } from './transaction.repository';
import { SpendingLimitService } from './spending-limit.service';
import { SpendingLimitGuard } from './guards/spending-limit.guard';
import { WalletModule } from '../wallets/wallet.module';
import { AgentModule } from '../agents/agent.module';
import { PolicyModule } from '../policies/policy.module';
import { RiskModule } from '../risk/risk.module';
import { BudgetModule } from '../budgets/budget.module';

/**
 * Transaction pipeline module. Pulls together wallets, agents, policies, risk
 * and budgets to enforce governance on every payment. Stellar + events are
 * provided globally. Exports the service so the approvals module can execute an
 * approved proposal's transaction.
 *
 * SpendingLimitService and SpendingLimitGuard are scoped to this module:
 *   - SpendingLimitService atomically aggregates agent spend and delegates
 *     evaluation to PolicyService (exported by PolicyModule).
 *   - SpendingLimitGuard is applied on TransactionController.create via the
 *     @RequireSpendingLimitCheck() decorator.
 * AuditService is provided globally via the @Global() AuditModule.
 */
@Module({
  imports: [WalletModule, AgentModule, PolicyModule, RiskModule, BudgetModule],
  controllers: [TransactionController],
  providers: [TransactionService, TransactionRepository, SpendingLimitService, SpendingLimitGuard],
  exports: [TransactionService, SpendingLimitService],
})
export class TransactionModule {}
