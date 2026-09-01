import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletRepository } from './wallet.repository';
import { BalanceCacheService } from './services/balance-cache.service';

/**
 * Wallet module. Exports the service so the transactions pipeline can resolve a
 * sender wallet, check its status and read its network. Also provides the
 * BalanceCacheService for Redis-cached balance reads.
 */
@Module({
  controllers: [WalletController],
  providers: [WalletService, WalletRepository, BalanceCacheService],
  exports: [WalletService, BalanceCacheService],
})
export class WalletModule {}
