import { Injectable, Logger } from '@nestjs/common';
import { Horizon, Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

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

  // Ideally Redis is injected via a provider, but we initialize here or inject
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
    _networkPassphrase = Networks.TESTNET
  ): Promise<unknown> {
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
          return await this.horizon.submitTransaction(transaction);
        } finally {
          await this.releaseLock(lockKey);
        }
      } catch (error: unknown) {
        const horizonError = error as HorizonError;
        const isTxBadSeq =
          horizonError?.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq';

        if (isTxBadSeq) {
          this.logger.warn(`tx_bad_seq encountered for ${publicKey}. Recovering sequence (attempt ${attempts}/${maxAttempts})...`);
          // Backoff before retry
          await this.sleep(attempts * 1000);
          continue;
        }

        throw error;
      }
    }
    throw new Error('Transaction failed after maximum sequence recovery attempts');
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
