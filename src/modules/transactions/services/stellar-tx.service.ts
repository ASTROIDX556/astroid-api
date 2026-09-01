import { Injectable, Logger } from '@nestjs/common';
import { BASE_FEE, Horizon, Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { DynamicFeeExceededException } from '../../../common/exceptions/domain.exception';

interface HorizonError {
  response?: {
    data?: {
      extras?: {
        result_codes?: {
          transaction?: string;
        };
      };
    };
  };
}

@Injectable()
export class StellarTxService {
  private readonly logger = new Logger(StellarTxService.name);
  private readonly horizon: Horizon.Server;
  private readonly maxBaseFee: number;
  private readonly congestionMode: 'fail' | 'flag';

  // Ideally Redis is injected via a provider, but we initialize here or inject
  constructor(
    private readonly configService: ConfigService,
    private readonly redis: Redis,
  ) {
    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL') || 'https://horizon-testnet.stellar.org';
    this.horizon = new Horizon.Server(horizonUrl);
    this.maxBaseFee = this.configService.get<number>('STELLAR_MAX_BASE_FEE', 1000);
    this.congestionMode =
      this.configService.get<string>('STELLAR_FEE_CONGESTION_MODE', 'fail') === 'flag'
        ? 'flag'
        : 'fail';
  }

  async submitTransactionWithSequenceRecovery(
    sourceSecret: string,
    buildTxFn: (sourceAccount: Horizon.AccountResponse) => Transaction,
    _networkPassphrase = Networks.TESTNET
  ): Promise<unknown> {
    // Guard against network congestion before doing any account/sequence work.
    await this.assertFeeWithinLimits();

    const keypair = Keypair.fromSecret(sourceSecret);
    const publicKey = keypair.publicKey();
    const lockKey = `lock:stellar_account:${publicKey}`;

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        // Acquire lock
        const lock = await this.acquireLock(lockKey, 10000);
        if (!lock) {
          throw new Error('Failed to acquire lock for account');
        }

        try {
          // Fetch account to get sequence
          const account = await this.horizon.loadAccount(publicKey);

          // Build transaction
          const transaction = buildTxFn(account);

          // Sign
          transaction.sign(keypair);

          // Submit
          const submission = await this.horizon.submitTransaction(transaction);
          this.logFeeMetrics(transaction, submission);
          return submission;
        } finally {
          await this.releaseLock(lockKey);
        }
      } catch (error: unknown) {
        const horizonError = error as HorizonError;
        const isTxBadSeq =
          horizonError?.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq';

        if (isTxBadSeq) {
          this.logger.warn(`tx_bad_seq encountered for ${publicKey}. Recovering sequence (attempt ${attempts}/${maxAttempts}):`);
          // Backoff before retry
          await this.sleep(attempts * 1000);
          continue;
        }

        throw error;
      }
    }
    throw new Error('Transaction failed after maximum sequence recovery attempts');
  }

  private async assertFeeWithinLimits(): Promise<void> {
    const networkBaseFee = await this.getNetworkBaseFee();
    if (networkBaseFee > this.maxBaseFee) {
      this.logger.warn(
        `Stellar network base fee ${networkBaseFee} exceeds safety limit ${this.maxBaseFee}`,
      );
      throw new DynamicFeeExceededException(this.maxBaseFee, networkBaseFee, this.congestionMode);
    }
  }

  private async getNetworkBaseFee(): Promise<number> {
    try {
      const feeStats = await this.horizon.feeStats();
      return Number(feeStats.last_ledger_base_fee);
    } catch (error) {
      this.logger.warn(`Failed to fetch Stellar fee stats: ${(error as Error).message}. Using BASE_FEE (${BASE_FEE}).`);
      return Number(BASE_FEE);
    }
  }

  private logFeeMetrics(
    transaction: Transaction,
    submission: Horizon.SubmitTransactionResponse,
  ): void {
    const estimatedFee = transaction.fee;
    const actualFee = Number(
      (submission as unknown as { fee_charged?: number | string }).fee_charged ?? estimatedFee,
    );
    this.logger.log(
      `Stellar transaction fee metrics: estimated=${estimatedFee} stroops, actual=${actualFee} stroops`,
    );
  }

  private async acquireLock(key: string, ttl: number): Promise<boolean> {
    const result = await this.redis.set(key, 'locked', 'PX', ttl, 'NX');
    return result === 'OK';
  }

  private async releaseLock(key: string): Promise<void> {
    await this.redis.del(key);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
