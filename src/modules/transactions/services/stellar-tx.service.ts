import { Injectable, Logger } from '@nestjs/common';

import { Horizon, Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

interface HorizonError {
  response?: { data?: { extras?: { result_codes?: { transaction?: string } } } }
}

export class DynamicFeeExceededException extends Error {
  constructor(public currentBaseFee: number, public maxBaseFee: number) {
    super(`Base fee ${currentBaseFee} exceeds max ${maxBaseFee}`);
    this.name = 'DynamicFeeExceededException';
  }
}

@Injectable()
export class StellarTxService {
  private readonly logger = new Logger(StellarTxService.name);
  private readonly horizon: Horizon.Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly redis: Redis,
  ) {
    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL') || 'https://horizon-testnet.stellar.org';
    this.horizon = new Horizon.Server(horizonUrl);
  }

  async submitTransactionWithSequenceRecovery(
    sourceSecret: string,
    buildTxFn: (sourceAccount: Horizon.AccountResponse) => Transaction,
    _networkPassphrase = Networks.TESTNET,
  ): Promise<unknown> {
    const keypair = Keypair.fromSecret(sourceSecret);
    const publicKey = keypair.publicKey();
    const lockKey = `lock:stellar_account:${publicKey}`;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const currentBaseFee = await this.assertFeeWithinSafetyLimit();
        const lock = await this.acquireLock(lockKey, 10000);
        if (!lock) throw new Error('Failed to acquire lock');
        try {
          const account = await this.horizon.loadAccount(publicKey);
          const transaction = buildTxFn(account);
          const estimatedFee = currentBaseFee * transaction.operations.length;
          this.logger.debug(`Estimated fee: ${estimatedFee}`);
          transaction.sign(keypair);
          const result: Horizon.TransactionResponse = await this.horizon.submitTransaction(transaction);
          const actualFeeCharged = parseInt(result.fee_charged, 10);
          this.logger.debug(`Estimated ${estimatedFee}, actual ${actualFeeCharged}`);
          return result;
        } finally {
          await this.releaseLock(lockKey);
        }
      } catch (error: unknown) {
        const horizonError = error as HorizonError;
        const isTxBadSeq = horizonError?.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq';
        if (isTxBadSeq) {
          this.logger.warn(`tx_bad_seq for ${publicKey}, attempt ${attempts}`);
          await this.sleep(attempts * 1000);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Transaction failed after max sequence recovery attempts');
  }

  private async assertFeeWithinSafetyLimit(): Promise<number> {
    const currentBaseFee = await this.fetchCurrentBaseFee();
    const maxBaseFee = this.getMaxBaseFee();
    if (currentBaseFee > maxBaseFee) {
      throw new DynamicFeeExceededException(currentBaseFee, maxBaseFee);
    }
    return currentBaseFee;
  }

  private async fetchCurrentBaseFee(): Promise<number> {
    const feeStats = await this.horizon.feeStats();
    const baseFee = parseInt(feeStats.last_ledger_base_fee, 10);
    if (Number.isNaN(baseFee) || baseFee <= 0) throw new Error('Invalid fee');
    return baseFee;
  }

  private getMaxBaseFee(): number {
    const configured = this.configService.get<number>('STELLAR_MAX_BASE_EEE');
    return configured && Number(configured) > 0 ? Number(configured) : 1000;
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
