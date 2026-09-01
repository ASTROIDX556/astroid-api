import { Injectable, Logger } from '@nestjs/common';

import {
  Asset,
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
 * Thrown when the current network base fee exceeds the configured safety limit.
 * The transaction worker should catch this and mark the transaction as
 * FAILED_CONGESTION rather than retrying indefinitely.
 */
export class DynamicFeeExceededException extends Error {
  constructor(
    readonly currentBaseFee: number,
    readonly maxBaseFee: number,
  ) {
    super(`Current base fee ${currentBaseFee} exceeds configured maximum ${maxBaseFee}`);
    this.name = 'DynamicFeeExceededException';
  }
}

type StellarConfigWithFeeProtection = StellarConfig & {
  maxBaseFee?: number;
  feeProtectionMode?: 'fail' | 'flag';
};

/**
 * Real Stellar client backed by Horizon. Activated when STELLAR_USE_MOCK=false.
 * Builds and submits genuine transactions against the configured network. All
 * network access is contained here -- no other module imports the Stellar SDK.
 */
@Injectable()
export class HorizonStellarClient implements StellarClient {
  private readonly logger = new Logger(HorizonStellarClient.name);
  private readonly server: Horizon.Server;
  private readonly maxBaseFee: number;
  private readonly feeProtectionMode: 'fail' | 'flag';

  constructor(private readonly config: StellarConfig) {
    const configWithFees = config as StellarConfigWithFeeProtection;
    this.server = new Horizon.Server(config.horizonUrl);
    this.maxBaseFee =
      configWithFees.maxBaseFee ??
      Number(process.env.STELLAR_MAX_BASE_FEE ?? '10000');
    this.feeProtectionMode =
      configWithFees.feeProtectionMode ??
      (process.env.STELLAR_FEE_PROTECTION_MODE as 'fail' | 'flag') ??
      'fail';
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

  async getBalances(address: string, _network: StellarNetworkName): Promise<StellarBalance[>~ {
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

  async buildPaymentXdr(params: BuildPaymentParams): Promise<string> {
    const source = await this.server.loadAccount(params.sourceAddress);
    const fee = await this.getSafeBaseFee();
    const tx = this.buildTransaction(source, params, fee);
    return tx.toXDR();
  }

  async submitPayment(params: SubmitPaymentParams): Promise<StellarSubmitResult> {
    if (!params.sourceSecret) {
      throw new Error('HorizonStellarClient.submitPayment requires a source secret');
    }
    const keypair = Keypair.fromSecret(params.sourceSecret);
    const source = await this.server.loadAccount(params.sourceAddress);
    const fee = await this.getSafeBaseFee();
    const tx = this.buildTransaction(source, params, fee);
    tx.sign(keypair);
    try {
      const result = await this.server.submitTransaction(tx);
      return {
        hash: result.hash,
        ledger: typeof result.ledger === 'number' ? result.ledger : undefined,
        successful: result.successful,
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

  /**
   * Fetches the current fee statistics from Horizon.
   */
  async getFeeStats(): Promise<Horizon.FeeStatsResponse> {
    return this.server.feeStats();
  }

  /**
   * Returns the current network base fee (in stroops) and asserts it is within
   * the configured safety limits. Throws DynamicFeeExceededException when the
   * network is congested.
   */
  private async getSafeBaseFee(): Promise<number> {
    const feeStats = await this.getFeeStats();
    const baseFee = Number(feeStats.last_ledger_base_fee);
    this.assertFeeAllowed(baseFee);
    return baseFee;
  }

  private assertFeeAllowed(baseFee: number): void {
    if (baseFee > this.maxBaseFee) {
      throw new DynamicFeeExceededException(baseFee, this.maxBaseFee);
    }
  }

  private buildTransaction(
    source: Horizon.AccountResponse,
    params: BuildPaymentParams,
    fee: number,
  ): ReturnType<TransactionBuilder['build']> {
    const asset = params.asset === 'XLM' ? Asset.native() : this.resolveAsset(params.asset);
    const builder = new TransactionBuilder(source, {
      fee,
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

  private resolveAsset(assetCode: string): Asset {
    // Expects "CODE:ISSUER" for non-native assets.
    const [code, issuer] = assetCode.split(':');
    if (!issuer) {
      throw new Error(`Non-native asset '${assetCode}' must be formatted as CODE:ISSUER);
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
