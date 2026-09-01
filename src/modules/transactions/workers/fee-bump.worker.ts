import { Processor, WorkerHost } from '@nestjs/bullqm';
import { Job } from 'bullqm';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Horizon, Keypair, FeeBumpTransaction, TransactionBuilder, Transaction } from '@stellar/stellar-sdk';

export interface FeeBumpJobData {
  organizationId: string;
  isSponsorshipEnabled: boolean;
  innerTransactionXdr: string;
  networkPassphrase: string;
}

interface BalanceLine {
  asset_type: string;
  balance: string;
}

interface AccountResponse {
  balances: BalanceLine[];
}

interface TransactionResponse {
  successful: boolean;
  fee_charged?: number | string;
}

interface HorizonError {
  response?: {
    data?: {
      extras?: {
        result_codes?: unknown;
      };
    };
  };
  message?: string;
}

export class DynamicFeeExceededException extends Error {
  constructor(currentBaseFee: number, maxBaseFee: number) {
    super(`Network base fee ${currentBaseFee} exceeds configured maximum ${maxBaseFee}`);
    this.name = 'DynamicFeeExceededException';
  }
}

const DEFAULT_MAX_BASE_FEE = 100000; // 0.01 XLM in stroops

@Injectable()
@Processor('stellar-fee-bump')
export class FeeBumpWorker extends WorkerHost {
  private readonly logger = new Logger(FeeBumpWorker.name);
  private readonly horizon: Horizon.Server;
  private readonly maxBaseFee: number;

  constructor(private readonly configService: ConfigService) {
    super();
    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL') || 'https://horizon-testnet.stellar.org';
    this.horizon = new Horizon.Server(horizonUrl);
    const configuredMax = this.configService.get<string>('STELLAR_MAX_BASE_FEE');
    this.maxBaseFee = configuredMax ? Number(configuredMax) : DEFAULT_MAX_BASE_FEE;
  }

  private async getCurrentBaseFee(): Promise<number> {
    const feeStats = await this.horizon.feeStats();
    return Number(feeStats.last_ledger_base_fee);
  }

  private assertFeeIsSafe(currentBaseFee: number): void {
    if (currentBaseFee > this.maxBaseFee) {
      throw new DynamicFeeExceededException(currentBaseFee, this.maxBaseFee);
    }
  }

  async process(job: Job<FeeBumpJobData>): Promise<TransactionResponse> {
    const { isSponsorshipEnabled, innerTransactionXdr, networkPassphrase } = job.data;
    
    // Convert base64 XDR to Transaction
    const innerTx = new Transaction(innerTransactionXdr, networkPassphrase);

    // Fetch current network base fee and validate against safety limits
    const currentBaseFee = await this.getCurrentBaseFee();
    this.assertFeeIsSafe(currentBaseFee);

    const operationCount = innerTx.operations.length;
    const estimatedFee = currentBaseFee * operationCount;
    this.logger.log(`Estimated fee for ${operationCount} operation(s): ${estimatedFee} stroops`);

    let txToSubmit: Transaction | FeeBumpTransaction = innerTx;

    if (isSponsorshipEnabled) {
      const sponsorSecret = this.configService.get<string>('STELLAR_FEE_SPONSOR_SECRET');
      if (!sponsorSecret) {
        throw new Error('Sponsor secret is not configured but sponsorship is enabled.');
      }
      
      const sponsorKeypair = Keypair.fromSecret(sponsorSecret);
      
      try {
        const sponsorAccount = await this.horizon.loadAccount(sponsorKeypair.publicKey()) as unknown as AccountResponse;
        // Simple check to see if sponsor has funds, although the actual submit will fail if not
        const xlmBalance = sponsorAccount.balances.find((b: BalanceLine) => b.asset_type === 'native');
        if (!xlmBalance || parseFloat(xlmBalance.balance) < 1) {
          throw new Error('Sponsor account lacks sufficient XML for fee bump.');
        }

        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
          sponsorKeypair,
          currentBaseFee.toString(),
          innerTx,
          networkPassphrase
        );

        feeBumpTx.sign(sponsorKeypair);
        txToSubmit = feeBumpTx;
        this.logger.log(`FeeBumpTransaction built for inner tx ${innerTx.hash().toString('hex')}`);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to apply fee bump: ${errorMessage}`);
      }
    }

    try {
      const response = await this.horizon.submitTransaction(txToSubmit) as unknown as TransactionResponse;
      const actualFee = response.fee_charged ? Number(response.fee_charged) : estimatedFee;
      
      if (isSponsorshipEnabled && txToSubmit instanceof FeeBumpTransaction) {
        const sponsorKey = txToSubmit.feeSource;
        // In actual implementation, we would insert an AuditLog via Prisma here
        this.logger.log(`AUDIT: Fee bump applied by ${sponsorKey}. Estimated fee: ${estimatedFee}, Actual fee charged: ${actualFee}`);
      }
      
      // Track fee metrics for telemetry
      this.logger.log(`Fee metrics: estimated_fee=${estimatedFee}, actual_fee=${actualFee}`);
      
      return response;
    } catch (error: unknown) {
      const horizonError = error as HorizonError;
      const errReason = horizonError?.response?.data?.extras?.result_codes || horizonError?.message || 'Unknown error';
      throw new Error(`Transaction submission failed: ${JSON.stringify(errReason)}`);
    }
  }
}