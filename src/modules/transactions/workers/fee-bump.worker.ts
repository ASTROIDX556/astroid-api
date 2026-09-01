import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
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

@Injectable()
@Processor('stellar-fee-bump')
export class FeeBumpWorker extends WorkerHost {
  private readonly logger = new Logger(FeeBumpWorker.name);
  private readonly horizon: Horizon.Server;

  constructor(private readonly configService: ConfigService) {
    super();
    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL') || 'https://horizon-testnet.stellar.org';
    this.horizon = new Horizon.Server(horizonUrl);
  }

  async process(job: Job<FeeBumpJobData>): Promise<TransactionResponse> {
    const { isSponsorshipEnabled, innerTransactionXdr, networkPassphrase } = job.data;
    
    // Convert base64 XDR to Transaction
    const innerTx = new Transaction(innerTransactionXdr, networkPassphrase);

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
          throw new Error('Sponsor account lacks sufficient XLM for fee bump.');
        }

        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
          sponsorKeypair,
          // base fee = min fee, or we could multiply inner fee. 
          // Defaulting to 10000 stroops (0.001 XLM)
          '10000',
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
      
      if (isSponsorshipEnabled && txToSubmit instanceof FeeBumpTransaction) {
        const sponsorKey = txToSubmit.feeSource;
        // In actual implementation, we would insert an AuditLog via Prisma here
        this.logger.log(`AUDIT: Fee bump applied by ${sponsorKey}. Actual fee charged: ${response.fee_charged}`);
      }
      
      return response;
    } catch (error: unknown) {
      const horizonError = error as HorizonError;
      const errReason = horizonError?.response?.data?.extras?.result_codes || horizonError.message || 'Unknown error';
      throw new Error(`Transaction submission failed: ${JSON.stringify(errReason)}`);
    }
  }
}
