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
  HorizonCircuitBreakerService,
  HttpSorobanClient,
  SorobanRpcClient,
  DEFAULT_SOROBAN_RPC_OPTIONS,
} from '../../integrations/stellar';
import { StellarService } from './stellar.service';
import { StellarTransactionService } from './services/stellar-transaction.service';
import { StellarController } from './stellar.controller';

/**
 * Global Stellar module. Selects the mock or Horizon-backed client (and the
 * mock or RPC-backed Soroban client) based on `stellar.useMock`, then exposes the higher-level {@link StellarService} to
 * every other module (wallets, transactions).
 *
 * The {@link HorizonCircuitBreakerService} is also provided here so it can be
 * injected by interceptors or other modules that need circuit-breaker health
 * checks or fallback configuration.
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
      inject: [ConfigService],
      useFactory: (config: ConfigService): SorobanClient => {
        const stellar = config.getOrThrow<StellarConfig>('stellar');
        if (stellar.useMock) return new MockSorobanClient();
        // Every real Soroban RPC call goes through SorobanRpcClient, which
        // enforces the timeout, retry and circuit-breaker policy.
        return new HttpSorobanClient(
          new SorobanRpcClient({
            endpoint: stellar.sorobanRpcUrl,
            ...DEFAULT_SOROBAN_RPC_OPTIONS,
            ...stellar.sorobanRpc,
          }),
        );
      },
    },
    {
      provide: HorizonCircuitBreakerService,
      inject: [ConfigService],
      useFactory: (config: ConfigService): HorizonCircuitBreakerService => {
        return new HorizonCircuitBreakerService(config);
      },
    },
    StellarService,
    StellarTransactionService,
  ],
  exports: [
    SOROBAN_CLIENT,
    StellarService,
    StellarTransactionService,
    HorizonCircuitBreakerService,
  ],
})
export class StellarModule {}
