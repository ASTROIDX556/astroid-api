import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarConfig } from '../../config/stellar.config';
import {
  HorizonStellarClient,
  MockStellarClient,
  STELLAR_CLIENT,
  StellarClient,
} from '../../integrations/stellar';
import { StellarService } from './stellar.service';
import { StellarTransactionService } from './services/stellar-transaction.service';
import { StellarController } from './stellar.controller';

/**
 * Global Stellar module. Selects the mock or Horizon-backed client based on
 * `stellar.useMock`, then exposes the higher-level {@link StellarService} to
 * every other module (wallets, transactions).
 */
@Global()
@Module({
  controllers: [StellarController],
  providers: [
    {
      provide: STELLAR_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StellarClient => {
        const stellar = config.getOrThrow<StellarConfig>('stellar');
        return stellar.useMock ? new MockStellarClient() : new HorizonStellarClient(stellar);
      },
    },
    StellarService,
    StellarTransactionService,
  ],
  exports: [StellarService, StellarTransactionService],
})
export class StellarModule {}
