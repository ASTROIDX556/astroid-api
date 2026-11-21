import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletRepository } from './wallet.repository';
import { BalanceCacheService } from './services/balance-cache.service';
import { WalletBalanceInvalidationListener } from './wallet-balance-invalidation.listener';

/**
 * Wallet module. Exports the service so the transactions pipeline can resolve a
 * sender wallet, check its status and read its network. Also provides the
 * BalanceCacheService for Redis-cached balance reads and the listener that
 * invalidates a cached balance when one of its transactions reaches a terminal
 * state.
 */
@Module({
  controllers: [WalletController],
  providers: [
    WalletService,
    WalletRepository,
    BalanceCacheService,
    WalletBalanceInvalidationListener,
  ],
  exports: [WalletService, BalanceCacheService],
})
export class WalletModule {}
