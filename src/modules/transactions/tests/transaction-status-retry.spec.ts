import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Prisma,
  Transaction,
  TransactionStatus,
  WalletStatus,
} from '@prisma/client';
import { TransactionService } from '../transaction.service';
import { TransactionRepository } from '../transaction.repository';
import { WalletService } from '../../wallets/wallet.service';
import { AgentService } from '../../agents/agent.service';
import { PolicyService } from '../../policies/policy.service';
import { RiskAggregatorService } from '../../risk/risk-aggregator.service';
import { BudgetService } from '../../budgets/budget.service';
import { StellarService } from '../../stellar/stellar.service';
import { EventBusService } from '../../../events/event-bus.service';
import { SpendingLimitService } from '../spending-limit.service';
import { PrismaService } from '../../../database/prisma.service';
import { PrismaTransactionService } from '../../../database/prisma-transaction.service';
import {
  ConflictException,
  NotFoundException,
} from '../../../common/exceptions/domain.exception';

/**
 * Stand-in for the interactive-transaction client handed to the callback. The
 * specs assert that status reads and writes actually run *inside* the retried
 * transaction by checking this object travels through as the third argument.
 */
const TX_CLIENT = { __transactionalClient: true };

/** Prisma's serialization-failure / write-conflict error. */
function serializationConflict(): Error & { code: string } {
  const error = new Error(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
  ) as Error & { code: string };
  error.code = 'P2034';
  return error;
}

/**
 * A real PrismaTransactionService whose `$transaction` can be programmed to
 * abort the first N attempts with a P2034 serialization conflict — the exact
 * failure PostgreSQL raises when concurrent workers race on the same rows.
 *
 * A failed attempt never invokes the callback, which models the committed
 * effect of a rolled-back transaction: none of its reads or writes become
 * visible, so the replay must re-read the row itself.
 */
function conflictPrismaService(failures: number) {
  const $transaction = vi.fn(
    async (fn: (tx: typeof TX_CLIENT) => Promise<unknown>, options?: unknown) => {
      if ($transaction.mock.calls.length <= failures) {
        throw serializationConflict();
      }
      void options;
      return fn(TX_CLIENT);
    },
  );
  const prisma = { $transaction } as unknown as PrismaService;
  return { service: new PrismaTransactionService(prisma), $transaction };
}

function makeRow(status: TransactionStatus): Transaction {
  return {
    id: 'tx_1',
    organizationId: 'org_1',
    walletId: 'wallet_1',
    status,
    asset: 'XLM',
    amount: new Prisma.Decimal('50.0000000'),
    recipientAddress: 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5',
    memo: null,
    budgetId: null,
    riskScore: 10,
    riskBand: 'LOW',
    deletedAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
  } as unknown as Transaction;
}

function makeWallet() {
  return {
    id: 'wallet_1',
    status: WalletStatus.ACTIVE,
    stellarAddress: 'GDWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    network: 'TESTNET',
    createdAt: new Date('2025-01-01T00:00:00Z'),
  };
}

describe('TransactionService status transitions under write conflicts', () => {
  let repository: {
    findById: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    hasPaidRecipient: ReturnType<typeof vi.fn>;
    recentCountForWallet: ReturnType<typeof vi.fn>;
  };
  let stellar: { submitPayment: ReturnType<typeof vi.fn> };
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let budgets: { consume: ReturnType<typeof vi.fn> };

  /**
   * Builds a TransactionService around a real retrying transaction manager
   * programmed to fail its first `failures` attempts with P2034.
   */
  function buildService(failures: number) {
    const { service: txManager, $transaction } = conflictPrismaService(failures);

    const service = new TransactionService(
      repository as unknown as TransactionRepository,
      {
        getOrThrow: vi.fn().mockResolvedValue(makeWallet()),
      } as unknown as WalletService,
      { getOrThrow: vi.fn() } as unknown as AgentService,
      {} as unknown as PolicyService,
      {} as unknown as RiskAggregatorService,
      budgets as unknown as BudgetService,
      stellar as unknown as StellarService,
      eventBus as unknown as EventBusService,
      {} as unknown as PrismaService,
      {} as unknown as SpendingLimitService,
      txManager,
    );

    return { service, $transaction };
  }

  beforeEach(() => {
    repository = {
      findById: vi.fn(),
      update: vi.fn().mockImplementation(
        async (id: string, data: Record<string, unknown>) =>
          ({ ...makeRow(TransactionStatus.DRAFT), id, ...data }) as unknown as Transaction,
      ),
      create: vi.fn(),
      hasPaidRecipient: vi.fn().mockResolvedValue(false),
      recentCountForWallet: vi.fn().mockResolvedValue(0),
    };
    stellar = {
      submitPayment: vi.fn().mockResolvedValue({
        successful: true,
        hash: 'stellar_hash_1',
        ledger: 100,
      }),
    };
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    budgets = { consume: vi.fn().mockResolvedValue(undefined) };
  });

  describe('cancel()', () => {
    it('replays a serialization conflict and cancels on the retry', async () => {
      const { service, $transaction } = buildService(1);
      repository.findById.mockResolvedValue(makeRow(TransactionStatus.DRAFT));

      const cancelled = await service.cancel('org_1', 'user_1', 'tx_1');

      expect(cancelled.status).toBe(TransactionStatus.CANCELLED);
      // Attempt 1 aborted with P2034, attempt 2 committed.
      expect($transaction).toHaveBeenCalledTimes(2);
      expect(repository.findById).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).toHaveBeenCalledTimes(1);
    });

    it('runs the status check and write inside the retried SERIALIZABLE transaction', async () => {
      const { service, $transaction } = buildService(1);
      repository.findById.mockResolvedValue(makeRow(TransactionStatus.DRAFT));

      await service.cancel('org_1', 'user_1', 'tx_1');

      // The guarded read + write both receive the transactional client, so they
      // commit or roll back as one unit...
      expect(repository.findById).toHaveBeenCalledWith('org_1', 'tx_1', TX_CLIENT);
      expect(repository.update).toHaveBeenCalledWith(
        'tx_1',
        { status: TransactionStatus.CANCELLED },
        TX_CLIENT,
      );

      // ...at SERIALIZABLE isolation, the level at which Postgres can actually
      // report the conflicting write (P2034) that triggers the replay.
      const options = $transaction.mock.calls[0][1] as
        | { isolationLevel?: Prisma.TransactionIsolationLevel }
        | undefined;
      expect(options?.isolationLevel).toBe(
        Prisma.TransactionIsolationLevel.Serializable,
      );
    });

    it('re-reads the row on replay and refuses to cancel a concurrently submitted transaction', async () => {
      const { service, $transaction } = buildService(1);
      // The concurrent worker committed SUBMITTED between the aborted attempt
      // and the replay; the replayed read must observe it.
      repository.findById.mockResolvedValue(makeRow(TransactionStatus.SUBMITTED));

      await expect(service.cancel('org_1', 'user_1', 'tx_1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect($transaction).toHaveBeenCalledTimes(2);
      expect(repository.update).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('propagates a non-conflict database error without replaying', async () => {
      const { service, $transaction } = buildService(0);
      repository.findById.mockResolvedValue(makeRow(TransactionStatus.DRAFT));
      const outage = new Error('connection reset by peer');
      repository.update.mockRejectedValue(outage);

      await expect(service.cancel('org_1', 'user_1', 'tx_1')).rejects.toBe(outage);

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('reports a missing transaction without retrying', async () => {
      const { service, $transaction } = buildService(0);
      repository.findById.mockResolvedValue(null);

      await expect(service.cancel('org_1', 'user_1', 'tx_gone')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('gives up after the retry budget is exhausted', async () => {
      const { service, $transaction } = buildService(10);
      repository.findById.mockResolvedValue(makeRow(TransactionStatus.DRAFT));

      await expect(service.cancel('org_1', 'user_1', 'tx_1')).rejects.toMatchObject({
        code: 'P2034',
      });

      // Defaults: 3 attempts total (PrismaTransactionService.DEFAULT_RETRY_ATTEMPTS).
      expect($transaction).toHaveBeenCalledTimes(3);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('execute()', () => {
    it('replays a serialization conflict and submits on-chain exactly once', async () => {
      const { service, $transaction } = buildService(1);
      repository.findById
        .mockResolvedValueOnce(makeRow(TransactionStatus.DRAFT)) // top-level read
        .mockResolvedValueOnce(makeRow(TransactionStatus.DRAFT)); // replayed guarded read

      const executed = await service.execute('org_1', 'tx_1', 'user_1');

      expect(executed.status).toBe(TransactionStatus.COMPLETED);
      expect($transaction).toHaveBeenCalledTimes(2);
      expect(stellar.submitPayment).toHaveBeenCalledTimes(1);
      // DRAFT -> SUBMITTED, then SUBMITTED -> COMPLETED after settlement.
      expect(repository.update).toHaveBeenCalledTimes(2);
      expect(repository.update).toHaveBeenNthCalledWith(
        1,
        'tx_1',
        { status: TransactionStatus.SUBMITTED },
        TX_CLIENT,
      );
      expect(budgets.consume).not.toHaveBeenCalled();
    });

    it('never submits twice when a concurrent worker won the race', async () => {
      const { service, $transaction } = buildService(1);
      repository.findById
        .mockResolvedValueOnce(makeRow(TransactionStatus.DRAFT)) // top-level read
        .mockResolvedValueOnce(makeRow(TransactionStatus.SUBMITTED)); // replayed guarded read

      await expect(service.execute('org_1', 'tx_1', 'user_1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect($transaction).toHaveBeenCalledTimes(2);
      expect(repository.update).not.toHaveBeenCalled();
      expect(stellar.submitPayment).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('fast-fails without opening a transaction when the row is already executed', async () => {
      const { service, $transaction } = buildService(0);
      repository.findById.mockResolvedValue(makeRow(TransactionStatus.COMPLETED));

      await expect(service.execute('org_1', 'tx_1', 'user_1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect($transaction).not.toHaveBeenCalled();
      expect(stellar.submitPayment).not.toHaveBeenCalled();
    });
  });
});
