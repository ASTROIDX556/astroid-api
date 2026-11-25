import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { DomainEventName } from '../../events/event-names';
import { TypedOnEvent } from '../../events/typed-event-listener.decorator';
import {
  TransactionCancelledPayload,
  TransactionCompletedPayload,
  TransactionFailedPayload,
} from '../../events/domain-event.types';
import { BalanceCacheService } from './services/balance-cache.service';
import { toNetworkName } from './wallet.service';

/**
 * Deletes the cached balance of the wallet whose transaction reached a terminal
 * state, so the next balance read is served from the Stellar RPC instead of a
 * snapshot taken before the transaction settled.
 *
 * Terminal states covered: `transaction.completed`, `transaction.failed` and
 * `transaction.cancelled` (a cancelled transaction can still be a balance
 * change if a fee was paid). Invalidation is best-effort: a failure is logged
 * and never propagates into the event bus or the operation that emitted it.
 */
@Injectable()
export class WalletBalanceInvalidationListener {
  private readonly logger = new Logger(WalletBalanceInvalidationListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceCache: BalanceCacheService,
  ) {}

  @TypedOnEvent(DomainEventName.TransactionCompleted)
  async onTransactionCompleted(payload: TransactionCompletedPayload): Promise<void> {
    await this.invalidateForTransaction(payload.transactionId);
  }

  @TypedOnEvent(DomainEventName.TransactionFailed)
  async onTransactionFailed(payload: TransactionFailedPayload): Promise<void> {
    await this.invalidateForTransaction(payload.transactionId);
  }

  @TypedOnEvent(DomainEventName.TransactionCancelled)
  async onTransactionCancelled(payload: TransactionCancelledPayload): Promise<void> {
    await this.invalidateForTransaction(payload.transactionId);
  }

  private async invalidateForTransaction(transactionId: string): Promise<void> {
    if (!transactionId) {
      return;
    }
    try {
      const transaction = await this.prisma.transaction.findUnique({
        where: { id: transactionId },
        select: {
          wallet: { select: { stellarAddress: true, network: true } },
        },
      });
      if (!transaction) {
        return;
      }
      const address = transaction.wallet.stellarAddress;
      const network = toNetworkName(transaction.wallet.network);
      await this.balanceCache.invalidate(address, network);
      this.logger.debug(
        `Invalidated the cached balance of ${address} on ${network} after transaction ${transactionId}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to invalidate the cached balance after transaction ${transactionId}: ${
          (error as Error).message
        }`,
      );
    }
  }
}
