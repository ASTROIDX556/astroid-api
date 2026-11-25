import { Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';
import { CircuitBreaker, isRpcFailure } from '../../common/circuit-breaker/circuit-breaker';
import {
  BuildPaymentParams,
  StellarBalance,
  StellarClient,
  StellarKeypair,
  StellarNetworkName,
  StellarSubmitResult,
  StellarTransactionInfo,
  SubmitPaymentParams,
  STELLAR_CLIENT,
} from '../../integrations/stellar';

/** Consecutive failures before the Horizon circuit trips OPEN. */
const HORIZON_FAILURE_THRESHOLD = 5;
/** Time the Horizon circuit stays OPEN before a HALF_OPEN trial call. */
const HORIZON_RESET_TIMEOUT_MS = 30_000;

/**
 * Thin domain service over the injected {@link StellarClient}. Adds validation
 * and consistent error mapping. This is the module boundary the rest of the app
 * uses; it never imports the Stellar SDK directly.
 *
 * Every client call is routed through a {@link CircuitBreaker} so that
 * Horizon/Soroban degradation fails fast (throwing a structured
 * {@link CircuitOpenException}) instead of piling up slow, cascading
 * timeouts across transaction submission and risk analysis workers.
 */
@Injectable()
export class StellarService {
  private readonly breaker = new CircuitBreaker({
    name: 'horizon',
    failureThreshold: HORIZON_FAILURE_THRESHOLD,
    resetTimeoutMs: HORIZON_RESET_TIMEOUT_MS,
    isFailure: isRpcFailure,
  });

  constructor(@Inject(STELLAR_CLIENT) private readonly client: StellarClient) {}

  generateKeypair(): StellarKeypair {
    return this.client.generateKeypair();
  }

  assertValidAddress(address: string): void {
    if (!this.client.isValidAddress(address)) {
      throw new DomainException(
        ErrorCode.INVALID_STELLAR_ADDRESS,
        `'${address}' is not a valid Stellar address`,
      );
    }
  }

  isValidAddress(address: string): boolean {
    return this.client.isValidAddress(address);
  }

  async getBalances(address: string, network: StellarNetworkName): Promise<StellarBalance[]> {
    return this.wrap(() => this.client.getBalances(address, network));
  }

  async getNativeBalance(address: string, network: StellarNetworkName): Promise<string> {
    return this.wrap(() => this.client.getNativeBalance(address, network));
  }

  async buildPaymentXdr(params: BuildPaymentParams): Promise<string> {
    return this.wrap(() => this.client.buildPaymentXdr(params));
  }

  async submitPayment(params: SubmitPaymentParams): Promise<StellarSubmitResult> {
    this.assertValidAddress(params.destinationAddress);
    return this.wrap(() => this.client.submitPayment(params));
  }

  async getTransaction(
    hash: string,
    network: StellarNetworkName,
  ): Promise<StellarTransactionInfo | null> {
    return this.wrap(() => this.client.getTransaction(hash, network));
  }

  private async wrap<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.breaker.execute(operation);
    } catch (error) {
      // CircuitOpenException extends DomainException, so an open circuit
      // (thrown by the breaker itself, before `operation` ever runs)
      // surfaces to callers unchanged and distinguishable via `error.code`.
      if (error instanceof DomainException) {
        throw error;
      }
      throw new DomainException(
        ErrorCode.STELLAR_ERROR,
        `Stellar operation failed: ${(error as Error).message}`,
      );
    }
  }
}
