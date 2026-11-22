import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import {
  DEFAULT_WALLET_RECONCILIATION_CONFIG,
  WalletReconciliationConfig,
} from '../../../config/wallet-reconciliation.config';
import { runWithConcurrency } from '../../../common/helpers/run-with-concurrency';
import { StellarService } from '../../stellar/stellar.service';
import {
  WalletReconciliationTarget,
  WalletRepository,
} from '../wallet.repository';
import { toNetworkName } from '../wallet.service';

/** Outcome of reconciling one wallet. */
export type WalletReconciliationOutcome = 'updated' | 'drifted' | 'unchanged' | 'failed';

/** Aggregate result of one reconciliation run. */
export interface WalletReconciliationSummary {
  /** Wallets the run attempted. */
  processed: number;
  /** Wallets whose snapshot was persisted (including drifted ones). */
  updated: number;
  /** Wallets whose delta exceeded the configured threshold. */
  drifted: number;
  /** Wallets whose upstream fetch or write failed. */
  failed: number;
}

/**
 * Scheduled reconciliation of stored wallet balances against Stellar.
 *
 * Every ACTIVE wallet is read once, its native (XLM) balance is fetched through
 * the Stellar integration, and — only when that fetch succeeds — the snapshot
 * and `lastSyncedAt` are persisted. A failed fetch leaves both untouched, so a
 * Horizon outage can never corrupt stored balances.
 *
 * A drift event is emitted at most once per wallet per run, and only when the
 * balance difference exceeds the configured threshold — never for a failed
 * fetch. Wallets are processed with bounded concurrency, and one failure is
 * logged with its wallet id without interrupting the rest of the run.
 */
@Injectable()
export class WalletReconciliationService {
  private readonly logger = new Logger(WalletReconciliationService.name);

  constructor(
    private readonly wallets: WalletRepository,
    private readonly stellar: StellarService,
    private readonly eventBus: EventBusService,
    private readonly config: ConfigService,
  ) {}

  private settings(): WalletReconciliationConfig {
    return (
      this.config.get<WalletReconciliationConfig>('walletReconciliation') ??
      DEFAULT_WALLET_RECONCILIATION_CONFIG
    );
  }

  async reconcile(): Promise<WalletReconciliationSummary> {
    const { concurrency } = this.settings();
    const wallets = await this.wallets.findActiveForReconciliation();
    const summary: WalletReconciliationSummary = {
      processed: wallets.length,
      updated: 0,
      drifted: 0,
      failed: 0,
    };

    await runWithConcurrency(wallets, concurrency, async (wallet) => {
      const outcome = await this.reconcileWallet(wallet);
      if (outcome === 'failed') summary.failed += 1;
      if (outcome === 'updated' || outcome === 'drifted') summary.updated += 1;
      if (outcome === 'drifted') summary.drifted += 1;
    });

    this.logger.log(
      `Wallet reconciliation finished: ${summary.processed} processed, ` +
        `${summary.updated} updated, ${summary.drifted} drifted, ${summary.failed} failed`,
    );
    return summary;
  }

  /**
   * Reconciles a single wallet. Never throws: upstream and persistence failures
   * are logged with the wallet id and reported as `failed`.
   */
  async reconcileWallet(wallet: WalletReconciliationTarget): Promise<WalletReconciliationOutcome> {
    try {
      const fetched = await this.stellar.getNativeBalance(
        wallet.stellarAddress,
        toNetworkName(wallet.network),
      );
      const newBalance = new Prisma.Decimal(fetched);
      const previous = wallet.balance;
      const reconciledAt = new Date();

      // Persist only after the upstream read succeeded.
      await this.wallets.update(wallet.id, {
        balance: newBalance,
        lastSyncedAt: reconciledAt,
      });

      if (previous === null) return 'updated';

      const threshold = this.settings().driftThreshold;
      const drifted = previous.minus(newBalance).abs().greaterThan(threshold);
      if (!drifted) return 'unchanged';

      try {
        await this.eventBus.emit(
          DomainEventName.WalletBalanceDriftDetected,
          {
            walletId: wallet.id,
            previousBalance: previous.toFixed(7),
            newBalance: newBalance.toFixed(7),
            reconciledAt: reconciledAt.toISOString(),
          },
          {
            organizationId: wallet.organizationId,
            aggregateType: 'wallet',
            aggregateId: wallet.id,
          },
        );
      } catch (error) {
        // The snapshot is already persisted; a subscriber failure must not turn
        // a successful reconciliation into a failed one.
        this.logger.warn(
          `Failed to emit balance drift for wallet ${wallet.id}: ${(error as Error).message}`,
        );
      }

      return 'drifted';
    } catch (error) {
      this.logger.error(
        `Wallet reconciliation failed for wallet ${wallet.id}: ${(error as Error).message}`,
      );
      return 'failed';
    }
  }
}
