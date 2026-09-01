import { Injectable, Logger } from '@nestj/common';
import { Horizon, Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import Redis from 'ioredis';
import { ConfigService } from '@nestj/config';
import { TransactionRepository } from '../transaction.repository';
import { DynamicFeeExceededException } from '../exceptions/dynamic-fee-exceeded.exception';
import { TRANSACTION_STATUS } from '../transaction-status';

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

const DEFAULT_MAX_BASE_FEE = 1000;

export type CongestionFallback = 'fail' | 'mark_congested';

export interface SubmitOptions {
  transactionId?: string;
  maxBaseFee?: number;
  fallback?: CongestionFallback;
}

@Injectable()\nexport class StellarTxService {\n  private readonly logger = new Logger(StellarTxService.name);\n  private readonly horizon: Horizon.Server;\n\n  constructor(\n    private readonly configService: ConfigService,\n    private readonly redis: Redis,\n    private readonly transactionRepository: TransactionRepository,\n  ) {\n    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL') || 'https://horizon-testnet.stellar.org';\n    this.horizon = new Horizon.Server(horizonUrl);\n  }\n\n  async submitTransactionWithSequenceRecovery(\n    sourceSecret: string,\n    buildTxFn: (sourceAccount: Horizon.AccountResponse) => Transaction,\n    _networkPassphrase = Networks.TESTNET,\n    options: SubmitOptions = {},\n  ): Promise<unknown> {\n    const keypair = Keypair.fromSecret(sourceSecret);\n    const publicKey = keypair.publicKey();\n    const lockKey = `lock:stellar_account:${publicKey}`;\n    \n    let attempts = 0;\n    const maxAttempts = 3;\n\n    while (attempts < maxAttempts) {\n      attempts++;\n      try {\n        // Acquire lock\n        const lock = await this.acquireLock(lockKey, 10000);\n        if (!lock) {\n          throw new Error('Failed to acquire lock for account');\n        }\n\n        try {\n          // Fetch account to get sequence\n          const account = await this.horizon.loadAccount(publicKey);\n          \n          // Build transaction\n          const transaction = buildTxFn(account);\n          \n          // Dynamic fee protection: verify current network base fee before submission.\n          const operationCount = transaction.operations.length;\n          const baseFee = await this.getAndValidateBaseFee(operationCount, options);\n          \n          // Sign\n          transaction.sign(keypair);\n\n          // Submit\n          const result = await this.horizon.submitTransaction(transaction);\n          \n          // Track fee metrics if transactionId is provided\n          if (options.transactionId) {\n            const actualFee = Number(result.fee_charged);\n            const estimatedFee = baseFee * operationCount;\n            await this.transactionRepository.update(options.transactionId, {\n              estimatedFee: estimatedFee.toString(),\n              actualFee: actualFee.toString(),\n              status: result.successful ? TRANSACTION_STATUS.COMPLETED : TRANSACTION_STATUS.FAILED,\n            });\n          }\n          \n          return result;\n        } finally {\n          await this.releaseLock(lockKey);\n        }\n      } catch (error: unknown) {\n        const horizonError = error as HorizonError;\n        const isTxBadSeq =\n          horizonError?.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq';\n\n        if (isTxBadSeq) {\n          this.logger.warn(`tx_bad_seq encountered for ${publicKey}. Recovering sequence (attempt ${attempts}/${maxAttempts})...`);\n          // Backoff before retry\n          await this.sleep(attempts * 1000);\n          continue;\n        }\n\n        throw error;\n      }\n    }\n    throw new Error('Transaction failed after maximum sequence recovery attempts');\n  }\n\n  private async getAndValidateBaseFee(operationCount: number, options: SubmitOptions): Promise<number> {\n    const baseFee = await this.getCurrentBaseFee();\n    const configuredMax = options.maxBaseFee ?? this.configService.get<number>('STELLAR_MAX_BASE_FEE') ?? DEFAULT_MAX_BASE_FEE;\n    if (baseFee > configuredMax) {\n      this.logger.warn(`Dynamic base fee ${baseFee} exceeds limit ${configuredMax} for transaction with ${operationCount} operation(s).`);\n      if (options.fallback === 'mark_congested' && options.transactionId) {\n        await this.transactionRepository.update(options.transactionId, {\n          status: TRANSACTION_STATUS.FAILED_CONGESTION,\n        });\n      }\n      throw new DynamicFeeExceededException(baseFee, configuredMax);\n    }\n    return baseFee;\n  }\n\n  private async getCurrentBaseFee(): Promise<number> {\n    const feeStats = await this.horizon.feeStats();\n    const lastLedgerBaseFee = typeof feeStats.last_ledger_base_fee === 'number' ? feeStats.last_ledger_base_fee : Number(feeStats.last_ledger_base_fee);\n    if (isNaN(lastLedgerBaseFee)) {\n      throw new Error('Failed to parse last_ledger_base_fee from Horizon fee stats');\n    }\n    return lastLedgerBaseFee;\n  }\n\n  private async acquireLock(key: string, ttl: number): Promise<boolean> {\n    const result = await this.redis.set(key, 'locked', 'PX', ttl, 'NX');\n    return result === 'OK';\n  }\n\n  private async releaseLock(key: string): Promise<void> {\n    await this.redis.del(key);\n  }\n\n  private sleep(ms: number): Promise<void> {\n    return new Promise(resolve => setTimeout(resolve, ms));\n  }\n}\n"}