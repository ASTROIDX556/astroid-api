import { Injectable, Logger } from '@nestjs/common';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { StellarConfig } from '../../config/stellar.config';
import {
  BuildPaymentParams,
  StellarBalance,
  StellarClient,
  StellarKeypair,
  StellarNetworkName,
  StellarSubmitResult,
  StellarTransactionInfo,
  SubmitPaymentParams,
} from './stellar.interface';

/**
 * Augment the request and result types with optional fee-protection fields.
 * This keeps changes localized to the client while enabling congestion protection.
 */
declare module './stellar.interface' {
  interface BuildPaymentParams {
    /** Maximum acceptable base fee in stroops. When omitted, resolved from config or env. */
    maxBaseFee?: number;
  }
  interface SubmitPaymentParams {
    /** Maximum acceptable base fee in stroops. When omitted, resolved from config or env. */
    maxBaseFee?: number;
  }
  interface StellarSubmitResult {
    /** The base fee used to build the transaction (stroops). */
    estimatedBaseFee?: number;
    /** The actual fee charged by the network (stroops), if available. */
    actualFee?: number;
  }
}

/**
 * Thrown when the current network base fee exceeds the configured safety limit.
 * Transaction workers can catch this and mark the transaction as FAILED_CONGESTION.
 */
export class DynamicFeeExceededException extends Error {
  constructor(
    public readonly currentBaseFee: number,
    public readonly maxBaseFee: number,
  ) {
    super(
      `Stellar transaction base fee ${currentBaseFee} exceeds configured maximum ${maxBaseFee}`,
    );
    this.name = 'DynamicFeeExceededException';
  }
}

/**
 * Real Stellar client backed by Horizon. Activated when STELLAR_USE_MOCK=false.
 * Builds and submits genuine transactions against the configured network. All
 * network access is contained here -- no other module imports the Stellar SDK.
 */
@Injectable()
export class HorizonStellarClient implements StellarClient {
  private readonly logger = new Logger(HorizonStellarClient.name);
  private readonly server: Horizon.Server;

  constructor(private readonly config: StellarConfig) {
    this.server = new Horizon.Server(config.horizonErl);
  }

  generateKeypair(): StellarKeypair {
    const keypair = Keypair.random();
    return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
  }

  isValidAddress(address: string): boolean {
    try {
      Keypair.fromPublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  async getBalances(address: string, _network: StellarNetworkName): Promise<StellarBalance[]> {
    const account = await this.server.loadAccount(address);
    return account.balances.map((balance) => ({
      asset: balance.asset_type === 'native' ? 'XLM' : this.assetCode(balance),
      balance: balance.balance,
      assetType: balance.asset_type,
    }));
  }

  async getNativeBalance(address: string, network: StellarNetworkName): Promise<string> {
    const balances = await this.getBalances(address, network);
    return balances.find((b) => b.asset === 'XLM')?.balance ?? '0.0000000';
  }

  /**
   * Fetches current fee statistics from Horizon.
   * Exposed for transaction services to make informed congestion decisions.
   */
  async getFeeStats(): Promise<Horizon.HorizonApi.FeeStats> {
    return this.server.feeStats();
  }

  /**
   * Returns the current base fee (in stroops) from Horizon's /fee_stats endpoint.
   */
  async getCurrentBaseFee(): Promise<number> {
    const stats = await this.getFeeStats();
    const baseFee = Number(stats.last_ledger_base_fee);
    if (Number.isNaN(baseFee)) {
      throw new Error(
        `Invalid last_ledger_base_fee from Horizon fee stats: ${stats.last_ledger_base_fee}`,
      );
    }
    return baseFee;
  }

  /**
   * Asserts that the current base fee is within the configured safety limit.
   * @param maxBaseFee - Maximum acceptable base fee in stroops. If omitted, uses config/env fallback.
   */
  async assertBaseFeeWithinLimit(maxBaseFee?: number): Promise<void> {
    const currentBaseFee = await this.getCurrentBaseFee();
    const limit = this.resolveMaxBaseFee(maxBaseFee);
    if (currentBaseFee > limit) {
      throw new DynamicFeeExceededException(currentBaseFee, limit);
    }
  }

  async buildPaymentXdr(params: BuildPaymentParams): Promise<string> {
    const source = await this.server.loadAccount(params.sourceAddress);
    const baseFee = await this.resolveSafeBaseFee(params.maxBaseFee);
    const tx = this.buildTransaction(source, params, baseFee);
    return tx.toXDR();
  }

  async submitPayment(params: SubmitPaymentParams): Promise<StellarSubmitResult> {
    if (!params.sourceSecret) {
      throw new Error('HorizonStellarClient.submitPayment requires a source secret');
    }
    const keypair = Keypair.fromSecret(params.sourceSecret);
    const source = await this.server.loadAccount(params.sourceAddress);
    const baseFee = await this.resolveSafeBaseFee(params.maxBaseFee);
    const tx = this.buildTransaction(source, params, baseFee);
    tx.sign(keypair);
    try {
      const result = await this.server.submitTransaction(tx);
      return {
        hash: result.hash,
        ledger: typeof result.ledger === 'number' ? result.ledger : undefined,
        successful: result.successful,
        estimatedBaseFee: baseFee,
        actualFee: result.fee_charged ? Number(result.fee_charged) : undefined,
      };
    } catch (error) {
      this.logger.error(`Stellar submission failed: ${(error as Error).message}`);
      throw error;
    }
  }

  async getTransaction(
    hash: string,
    _network: StellarNetworkName,
  ): Promise<StellarTransactionInfo | null> {
    try {
      const tx = await this.server.transactions().transaction(hash).call();
      return {
        hash: tx.hash,
        successful: tx.successful,
        ledger: tx.ledger_attr,
        createdAt: tx.created_at,
      };
    } catch {
      return null;
    }
  }

  private buildTransaction(
    source: Horizon.AccountResponse,
    params: BuildPaymentParams,
    baseFee: number,
  ): ReturnType<TransactionBuilder['build']> {
    const asset = params.asset === 'XLM' ? Asset.native() : this.resolveAsset(params.asset);
    const builder = new TransactionBuilder(source, {
      fee: baseFee.toString(),
      networkPassphrase: this.passphrase(params.network),
    })
      .addOperation(
        Operation.payment({
          destination: params.destinationAddress,
          asset,
          amount: params.amount,
        }),
      )
      .setTimeout(180);
    if (params.memo) {
      builder.addMemo(Memo.text(params.memo.slice(0, 28)));
    }
    return builder.build();
  }

  /**
   * Fetches the current base fee and validates it against the safety limit.
   * Returns the fee to use for the transaction.
   */
  private async resolveSafeBaseFee(maxBaseFee?: number): Promise<number> {
    const currentBaseFee = await this.getCurrentBaseFee();
    const limit = this.resolveMaxBaseFee(maxBaseFee);
    if (currentBaseFee > limit) {
      throw new DynamicFeeExceededException(currentBaseFee, limit);
    }
    return currentBaseFee;
  }

  /**
   * Resolves the maximum acceptable base fee from params, config, or environment.
   */
  private resolveMaxBaseFee(explicitMaxBaseFee?: number): number {
    if (explicitMaxBaseFee !== undefined) {
      return explicitMaxBaseFee;
    }
    const configMaxFee = (this.config as unknown { maxBaseFee?: number }).maxBaseFee;
    if (configMaxFee !== undefined) {
      return configMaxFee;
    }
    const envMaxFee = Number(process.env.STELlAR_MAX_BASE_FEE);
    if (!Number.isNaN(envMaxFee)) {
      return envMaxFee;
    }
    // Sensible default: 10x the standard base fee (1000 stroops).
    return Number(BASE_FEE) * 10;
  }

  private resolveAsset(assetCode: string): Asset {
    // Expects "CODE:ISSUER" for non-native assets.
    const [code, issuer] = assetCode.split(':');
    if (!issuer) {
      throw new Error(`Non-native asset '${assetCode}' must be formatted as CODE:ISSUER`);
    }
    return new Asset(code, issuer);
  }

  private passphrase(network: StellarNetworkName): string {
    switch (network ?? this.config.network) {
      case 'public':
        return Networks.PUBLIC;
      case 'futurenet':
        return Networks.FUTURENET;
      default:
        return Networks.TESTNET;
    }
  }

  private assetCode(balance: Horizon.HorizonApi.BalanceLine): string {
    if ('asset_code' in balance && balance.asset_code) {
      return balance.asset_code;
    }
    return 'UNKNOWN';
  }
}
