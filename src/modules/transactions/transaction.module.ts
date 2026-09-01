import { Module } from '@nestjs/common';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { TransactionRepository } from './transaction.repository';
import { StellarSimulationService } from './services/stellar-simulation.service';
import { SorobanSimulationService } from './services/soroban-simulation.service';
import { WalletModule } from '../wallets/wallet.module';
import { AgentModule } from '../agents/agent.module';
import { PolicyModule } from '../policies/policy.module';
import { RiskModule } from '../risk/risk.module';
import { BudgetModule } from '../budgets/budget.module';

/**
 * Transaction pipeline module. Pulls together wallets, agents, policies, risk
 * and budgets to enforce governance on every payment, and wires the pre-flight
 * simulation services (`StellarSimulationService` + `SorobanSimulationService`)
 * used to validate transactions on-chain before submission. Stellar + events
 * are provided globally. Exports the service so the approvals module can
 * execute an approved proposal's transaction.
 */
@Module({
  imports: [WalletModule, AgentModule, PolicyModule, RiskModule, BudgetModule],
  controllers: [TransactionController],
  providers: [
    TransactionService,
    TransactionRepository,
    StellarSimulationService,
    SorobanSimulationService,
  ],
  exports: [TransactionService, StellarSimulationService, SorobanSimulationService],
})
export class TransactionModule {}
