import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarConfig } from '../../config/stellar.config';
import {
  HorizonStellarClient,
  MockStellarClient,
  MockSorobanClient,
  STELLAR_CLIENT,
  SOROBAN_CLIENT,
  StellarClient,
  SorobanClient,
} from '../../integrations/stellar';
import { StellarService } from './stellar.service';
import { StellarTransactionService } from './services/stellar-transaction.service';
import { StellarController } from './stellar.controller';
import { SorobanEventParserService } from './services/soroban-event-parser.service';

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
    {
      provide: SOROBAN_CLIENT,
      useFactory: (): SorobanClient => {
        return new MockSorobanClient();
      },
    },
    StellarService,
    StellarTransactionService,
    SorobanEventParserService,
  ],
  exports: [StellarService, StellarTransactionService, SorobanEventParserService],
})
export class StellarModule {}
