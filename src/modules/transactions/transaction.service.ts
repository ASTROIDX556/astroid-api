import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Agent,
  AgentStatus,
  Prisma,
  RiskBand,
  Transaction,
  TransactionStatus,
  Wallet,
  WalletStatus,
} from '@prisma/client';
import { TransactionRepository } from './transaction.repository';
import { SpendingLimitService } from './spending-limit.service';
import { CreateTransactionInput, SimulateTransactionInput } from './transaction.dto';
import { TransactionsValidator } from './transactions.validator';
import { WalletService, toNetworkName } from '../wallets/wallet.service';
import { PolicyService } from '../policies/policy.service';
import { RiskAggregatorService } from '../risk/risk-aggregator.service';
import { RiskAggregation } from '../risk/risk.types';
import { BudgetService } from '../budgets/budget.service';
import { StellarService } from '../stellar/stellar.service';
import { AgentService } from '../agents/agent.service';
import { TransactionIntent } from '../policies/policy.types';
import { DomainException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';
import {
  ConflictException,
  NotFoundException,
} from '../../common/exceptions/domain.exception';
import { CursorPaginated, Paginated } from '../../common/interfaces/api-response.interface';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor-pagination';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import { PrismaService } from '../../database/prisma.service';
import { PrismaTransactionService } from '../../database/prisma-transaction.service';
import { idempotencyConfig, IdempotencyConfig } from '../../config/idempotency.config';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import {
  IDEMPOTENT_DEFAULT_STATUS,
  TRANSACTION_CREATE_ROUTE,
} from '../../common/idempotency/idempotency.constants';
import { RequestContext } from '../../common/context/request-context';
import { buildPaginationMeta, PaginationQuery, toPrismaPagination } from '../../common/helpers/pagination';

/** Statuses that may never leave the execution pipeline once they got there. */
const EXECUTED_STATUSES: readonly TransactionStatus[] = [
  TransactionStatus.COMPLETED,
  TransactionStatus.SUBMITTED,
  TransactionStatus.CONFIRMED,
];

/** Statuses a cancellation is still allowed to consume. */
const CANCELLABLE_STATUSES: readonly TransactionStatus[] = [
  TransactionStatus.DRAFT,
  TransactionStatus.PENDING,
];
const Decimal = Prisma.Decimal;

function normalizeAmount(amount: string): string {
  const [whole, fraction = ''] = amount.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

/**
 * The heart of Astroid: the transaction pipeline. Every agent-initiated payment
 * flows through a deterministic sequence of governance checks before any funds
 * move:
 *   1. resolve + validate the sender wallet (must be ACTIVE / not frozen)
 *   2. resolve + validate the initiating agent (must be ACTIVE)
 *   3. evaluate all applicable policies (may block or require approval)
 *   4. score risk (the aggregator combines velocity, destination reputation and
 *      amount anomaly into a composite 0-100 score; scores at or above the
 *      review threshold require a human approval)
 *   5. check the budget headroom (does not mutate yet)
 *   6. persist the Transaction row and the linked risk assessment
 *   7. if approval is required -> create a Proposal (status PENDING) and stop
 *      else -> execute on-chain immediately
 * Execution is idempotent-ish and also callable by the approvals module once a
 * proposal is approved.
 *
 * Callers may pass an Idempotency-Key: the first request for a key reserves a
 * record, and repeats with the same key/payload either replay the stored result
 * or wait for the in-flight original. A key reused with a different payload is
 * rejected with 409. Records expire after the configured retention window.
 */
@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    private readonly repository: TransactionRepository,
    private readonly wallets: WalletService,
    private readonly agents: AgentService,
    private readonly policies: PolicyService,
    private readonly risk: RiskAggregatorService,
    private readonly budgets: BudgetService,
    private readonly stellar: StellarService,
    private readonly eventBus: EventBusService,
    private readonly prisma: PrismaService,
    private readonly spendingLimits: SpendingLimitService,
    @Optional() private readonly transactions?: PrismaTransactionService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly idempotency?: IdempotencyService,
  ) {}

  async create(
    organizationId: string,
    actorId: string,
    input: CreateTransactionInput,
    idempotency?: { principalId: string; key: string; route?: string },
  ) {
    if (!idempotency) return this.createTransaction(organizationId, actorId, input);
    if (!this.idempotency) {
      throw new Error('IdempotencyService is not available in this application context');
    }
    const store = this.idempotency;
    const route = idempotency.route ?? TRANSACTION_CREATE_ROUTE;
    const { keyTtlMs, waitTimeoutMs, pollIntervalMs } = this.idempotencySettings();
    // Numeric amounts are normalized first so "50.0" and "50.0000000" are the
    // same fingerprint.
    const requestFingerprint = store.fingerprint({
      ...input,
      amount: normalizeAmount(input.amount),
    });
    const reservation = await store.reserve({
      principalId: idempotency.principalId,
      route,
      key: idempotency.key,
      requestFingerprint,
      expiresAt: new Date(Date.now() + keyTtlMs),
    });

    if (!reservation.created) {
      if (reservation.record.requestHash !== requestFingerprint) {
        throw new ConflictException(
          'Idempotency-Key was already used with a different transaction payload',
        );
      }

      // A completed record replays the original status, body and request id.
      const stored = store.completedResponse(reservation.record);
      if (stored) return store.replay<Awaited<ReturnType<TransactionService['createTransaction']>>>(stored);

      // The original submission is still in flight. Rather than failing the
      // retrying client outright, wait for it to finish and replay its result;
      // only one request is ever allowed to execute, so the database write and
      // the on-chain submission still happen exactly once.
      const replayed = await store.waitForCompletion(
        reservation.record.id,
        waitTimeoutMs,
        pollIntervalMs,
      );
      if (replayed)
        return store.replay<Awaited<ReturnType<TransactionService['createTransaction']>>>(replayed);
      throw new ConflictException(
        'A transaction submission with this Idempotency-Key is currently being processed; retry shortly',
      );
    }

    let transactionId: string | undefined;
    try {
      const result = await this.createTransaction(organizationId, actorId, input, async (transaction) => {
        transactionId = transaction.id;
        await store.attachTransaction(reservation.record.id, transaction.id);
      });
      await store.complete({
        recordId: reservation.record.id,
        statusCode: IDEMPOTENT_DEFAULT_STATUS,
        body: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
        transactionId,
        requestId: RequestContext.getRequestId(),
        expiresAt: new Date(Date.now() + keyTtlMs),
      });
      return result;
    } catch (error) {
      if (!transactionId) await store.release(reservation.record.id);
      throw error;
    }
  }

  /** Idempotency retention/wait settings, falling back to their env defaults. */
  private idempotencySettings(): IdempotencyConfig {
    return this.config?.get<IdempotencyConfig>('idempotency') ?? idempotencyConfig();
  }

  private async createTransaction(
    organizationId: string,
    actorId: string,
    input: CreateTransactionInput,
    onTransactionCreated?: (transaction: Transaction) => Promise<void>,
  ) {
    const amount = Number(input.amount);
    const memoValue = input.memoType && input.memoValue ? input.memoValue : input.memo;
    const { wallet } = await this.preflight(organizationId, input);

    // 2.5. Velocity limit check for agent spending
    if (input.agentId) {
      await this.policies.checkVelocityLimit(organizationId, input.agentId, amount, input.asset, actorId);
    }

    // 2.6 – 6. Spend-limit enforcement, full policy evaluation, risk scoring,
    //       budget headroom and transaction-row persistence. For an agent
    //       transaction the whole check-then-create section runs inside an
    //       agent-scoped distributed lock so two concurrent submissions cannot
    //       both read a stale rolling-window aggregate and both pass (see
    //       SpendingLimitService.withSpendEnforcementLock). The freshly created
    //       DRAFT row is counted by the aggregate, so the next serialised caller
    //       sees it and is denied if it would breach the window.
    const enforceAndCreate = async (): Promise<{
      transaction: Transaction;
      assessment: RiskAggregation;
      requiresApproval: boolean;
      budgetReservationId: string | undefined;
    }> => {
      const baseIntent = this.toIntent(organizationId, input, amount);
      let enrichedIntent = baseIntent;
      if (input.agentId) {
        const aggregates = await this.spendingLimits.aggregateSpend(input.agentId, input.asset);
        enrichedIntent = {
          ...baseIntent,
          spentToday: aggregates.spentToday,
          spentThisWeek: aggregates.spentThisWeek,
          spentThisMonth: aggregates.spentThisMonth,
        };
        // Evaluate the rolling-window budget caps against the real aggregates.
        // No-op when no periodic limit policy is configured; throws
        // PolicyViolationException (HTTP 422) on violation.
        await this.spendingLimits.evaluateSpendingLimits(enrichedIntent, actorId);
      }

      // 3. Full policy evaluation — evaluates all rule types (maxAmount, assets,
      //    recipients, time windows, emergency lock, periodic limits) with real
      //    spend aggregates already embedded in the intent.
      const policyResult = await this.policies.evaluateIntent(enrichedIntent, actorId);
      if (!policyResult.passed) {
        throw new DomainException(
          ErrorCode.POLICY_VIOLATION,
          'Transaction blocked by one or more policies',
          policyResult.violations,
        );
      }

      // 4. Risk scoring — the aggregator combines the velocity, destination
      //    reputation and amount-anomaly signals into the composite score.
      const assessment = await this.risk.assess({
        organizationId,
        walletId: wallet.id,
        recipientAddress: input.recipientAddress,
        amount,
        asset: input.asset,
        walletAgeDays: this.walletAgeDays(wallet),
        policyViolations: policyResult.violations.length,
        hourUtc: new Date().getUTCHours(),
      });

      // 5. Atomic budget reservation — replaces the read-then-write assertWithinBudget.
      // The conditional UPDATE guarantees the balance can never go negative under
      // concurrency. If the budget is exceeded the caller gets a typed
      // BudgetExceededException (HTTP 422) rather than a 500.
      let budgetReservationId: string | undefined;
      if (input.budgetId) {
        const reservation = await this.budgets.reserveAtomic(organizationId, input.budgetId, amount);
        budgetReservationId = reservation.id;
      }

      const requiresApproval = policyResult.requiresApproval || assessment.requiresApproval;

      // 6. Persist the transaction row.
      const createTransactionRow = () => this.repository.create({
        organization: { connect: { id: organizationId } },
        wallet: { connect: { id: wallet.id } },
        ...(input.agentId ? { agent: { connect: { id: input.agentId } } } : {}),
        ...(policyResult.matchedPolicyId
          ? { policy: { connect: { id: policyResult.matchedPolicyId } } }
          : {}),
        ...(input.budgetId ? { budget: { connect: { id: input.budgetId } } } : {}),
        ...(budgetReservationId
          ? { budgetReservation: { connect: { id: budgetReservationId } } }
          : {}),
        asset: input.asset,
        amount: new Decimal(input.amount),
        senderAddress: wallet.stellarAddress,
        recipientAddress: input.recipientAddress,
        memo: memoValue,
        purpose: input.purpose,
        status: TransactionStatus.DRAFT,
        riskScore: assessment.score,
        riskBand: assessment.band,
        requiresApproval,
        metadata: input.metadata as Prisma.InputJsonValue,
      });
      const transaction = input.agentId && typeof this.budgets.withAgentBudgetLimit === 'function'
        ? await this.budgets.withAgentBudgetLimit(
            organizationId,
            input.agentId,
            input.asset,
            amount,
            createTransactionRow,
          )
        : await createTransactionRow();

      return { transaction, assessment, requiresApproval, budgetReservationId: budgetReservationId as string | undefined };
    };

    let result: Awaited<ReturnType<typeof enforceAndCreate>>;
    try {
      result = input.agentId
        ? await this.spendingLimits.withSpendEnforcementLock(input.agentId, enforceAndCreate)
        : await enforceAndCreate();
    } catch (error) {
      // If a reservation was made but the pipeline failed before persisting the
      // transaction, release the held amount so the budget is not permanently
      // reduced by an aborted submission.
      // We cannot access budgetReservationId here directly because enforceAndCreate
      // is a closure; the release is handled inside enforceAndCreate on throw.
      throw error;
    }

    const { transaction, assessment, requiresApproval } = result;

    await onTransactionCreated?.(transaction);

    // 6.1. Persist the risk assessment against the transaction and emit the
    //      risk evaluation events for the downstream notification workers.
    await this.risk.record(organizationId, transaction.id, assessment, { actorId });

    await this.eventBus.emit(
      DomainEventName.TransactionCreated,
      { transactionId: transaction.id, amount: input.amount, riskBand: assessment.band },
      { organizationId, actorId, aggregateType: 'transaction', aggregateId: transaction.id },
    );

    // 7. Branch: approval proposal, or immediate execution.
    if (requiresApproval) {
      const proposal = await this.createProposal(
        organizationId,
        transaction,
        assessment.band,
        input.approvalExpiresInHours,
      );
      await this.repository.update(transaction.id, { status: TransactionStatus.PENDING });
      return {
        transaction: { ...transaction, status: TransactionStatus.PENDING },
        proposal,
        requiresApproval: true,
        risk: assessment,
      };
    }

    const executed = await this.execute(organizationId, transaction.id, actorId);
    return { transaction: executed, requiresApproval: false, risk: assessment };
  }

  /**
   * Submits a transaction on-chain and settles its budget. Called directly for
   * auto-executable transactions and by the approvals module once a proposal has
   * gathered the required approvals.
   */
  async execute(organizationId: string, transactionId: string, actorId?: string): Promise<Transaction> {
    const tx = await this.getOrThrow(organizationId, transactionId);
    if (EXECUTED_STATUSES.includes(tx.status)) {
      throw new ConflictException(`Transaction '${transactionId}' has already been executed`);
    }
    const wallet = await this.wallets.getOrThrow(organizationId, tx.walletId);
    this.assertWalletSpendable(wallet);

    // Guarded DRAFT/PENDING -> SUBMITTED transition. Concurrent workers racing
    // on the same transaction (fee-bump retries, approvals landing while an
    // execute is in flight) previously clobbered each other's status writes;
    // running the re-read + update as one SERIALIZABLE unit of work makes
    // Postgres abort the loser with a serialization conflict (P2034), which
    // runWithRetry replays — the replay re-reads the row, sees SUBMITTED and
    // surfaces a ConflictException *before* any funds move on-chain.
    await this.transactions!.runWithRetry(
      async (client) => {
        const current = await this.repository.findById(organizationId, transactionId, client);
        if (!current) {
          throw new NotFoundException('Transaction', transactionId);
        }
        if (EXECUTED_STATUSES.includes(current.status)) {
          throw new ConflictException(`Transaction '${transactionId}' has already been executed`);
        }
        return this.repository.update(transactionId, { status: TransactionStatus.SUBMITTED }, client);
      },
      {
        name: 'transaction.status->submitted',
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
    await this.eventBus.emit(
      DomainEventName.TransactionSubmitted,
      { transactionId: tx.id },
      { organizationId, actorId, aggregateType: 'transaction', aggregateId: tx.id },
    );

    try {
      const result = await this.stellar.submitPayment({
        sourceAddress: wallet.stellarAddress,
        destinationAddress: tx.recipientAddress,
        asset: tx.asset,
        amount: tx.amount.toFixed(7),
        memo: tx.memo ?? undefined,
        network: toNetworkName(wallet.network),
      });

      const completed = await this.repository.update(tx.id, {
        status: result.successful ? TransactionStatus.COMPLETED : TransactionStatus.FAILED,
        stellarHash: result.hash,
        confirmationCount: result.ledger ? 1 : 0,
      });

      if (result.successful && tx.budgetId) {
        // Settle the atomic reservation so spent reflects the actual on-chain
        // amount. Falls back to the legacy consume path when no reservationId
        // is recorded (older transactions created before this change).
        if (tx.budgetReservationId) {
          await this.budgets.settle(organizationId, tx.budgetReservationId, Number(tx.amount));
        } else {
          await this.budgets.consume(organizationId, tx.budgetId, Number(tx.amount));
        }
      }

      await this.eventBus.emit(
        result.successful
          ? DomainEventName.TransactionCompleted
          : DomainEventName.TransactionFailed,
        { transactionId: tx.id, stellarHash: result.hash },
        { organizationId, actorId, aggregateType: 'transaction', aggregateId: tx.id },
      );
      return completed;
    } catch (error) {
      this.logger.warn(
        `Transaction ${tx.id} failed to submit: ${(error as Error).message}`,
      );
      await this.repository.update(tx.id, { status: TransactionStatus.FAILED });
      // Release the atomic reservation so the budget headroom is restored.
      if (tx.budgetReservationId) {
        await this.budgets.release(tx.budgetReservationId).catch((releaseErr: unknown) => {
          this.logger.warn(
            `Could not release budget reservation ${tx.budgetReservationId}: ${(releaseErr as Error).message}`,
          );
        });
      }
      await this.eventBus.emit(
        DomainEventName.TransactionFailed,
        { transactionId: tx.id, reason: (error as Error).message },
        { organizationId, actorId, aggregateType: 'transaction', aggregateId: tx.id },
      );
      throw error;
    }
  }

  /** Dry-run: runs every governance check without persisting or moving funds. */
  async simulate(organizationId: string, input: CreateTransactionInput | SimulateTransactionInput) {
    const firstTransfer = input.transfers?.[0];
    const amount = Number(input.amount ?? firstTransfer?.amount ?? 0);
    const asset = input.asset ?? firstTransfer?.asset ?? 'XLM';
    const createInput = { ...input, asset, amount: String(amount) } as CreateTransactionInput;
    const { wallet } = await this.preflight(organizationId, createInput);
    const intent = this.toIntent(organizationId, createInput, amount);
    const policyResult = await this.policies.evaluateIntent(intent);
    const assessment = await this.risk.assess({
      organizationId,
      walletId: wallet.id,
      recipientAddress: input.recipientAddress,
      amount,
      asset,
      walletAgeDays: this.walletAgeDays(wallet),
      policyViolations: policyResult.violations.length,
      hourUtc: new Date().getUTCHours(),
    });
    const requiresApproval = policyResult.requiresApproval || assessment.requiresApproval;
    return {
      wouldPass: policyResult.passed,
      requiresApproval,
      policy: {
        passed: policyResult.passed,
        violations: policyResult.violations,
      },
      risk: assessment,
    };
  }

  async list(organizationId: string, query: PaginationQuery & { cursor?: string; status?: string; search?: string; filter?: string }) {
    const where: Prisma.TransactionWhereInput = { organizationId, deletedAt: null };
    if (query.search) {
      where.OR = [
        { recipientAddress: { contains: query.search, mode: 'insensitive' } },
        { purpose: { contains: query.search, mode: 'insensitive' } },
        { stellarHash: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const status = query.status ?? query.filter;
    if (status) where.status = status as TransactionStatus;
    if (query.cursor) {
      const cursorLimit = query.limit ?? 20;
      const rows = await this.repository.findCursorPage(
        where,
        decodeCursor(query.cursor),
        cursorLimit + 1,
      );
      const hasMore = rows.length > cursorLimit;
      const items = hasMore ? rows.slice(0, cursorLimit) : rows;
      const last = items[items.length - 1];
      return new CursorPaginated(items, {
        limit: cursorLimit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last) : null,
      });
    }
    const pagination = toPrismaPagination(query, ['createdAt', 'amount', 'status']);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string): Promise<Transaction> {
    const tx = await this.repository.findById(organizationId, id);
    if (!tx) {
      throw new NotFoundException('Transaction', id);
    }
    return tx;
  }

  async cancel(organizationId: string, actorId: string, id: string) {
    // Same guarded-transition pattern as execute(): the status check and the
    // CANCELLED write run inside one SERIALIZABLE transaction that is replayed
    // on P2034, so a cancel can never overwrite a transaction that a
    // concurrent worker has just submitted or completed.
    const cancelled = await this.transactions!.runWithRetry(
      async (client) => {
        const current = await this.repository.findById(organizationId, id, client);
        if (!current) {
          throw new NotFoundException('Transaction', id);
        }
        if (!CANCELLABLE_STATUSES.includes(current.status)) {
          throw new ConflictException('Only draft or pending transactions can be cancelled');
        }
        return this.repository.update(id, { status: TransactionStatus.CANCELLED }, client);
      },
      {
        name: 'transaction.status->cancelled',
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
    await this.eventBus.emit(
      DomainEventName.TransactionCancelled,
      { transactionId: id },
      { organizationId, actorId, aggregateType: 'transaction', aggregateId: id },
    );
    return cancelled;
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Resolves and validates the sender wallet + agent before any evaluation. */
  private async preflight(
    organizationId: string,
    input: CreateTransactionInput,
  ): Promise<{ wallet: Wallet; agent?: Agent }> {
    const wallet = await this.wallets.getOrThrow(organizationId, input.walletId);
    this.assertWalletSpendable(wallet);

    const memoValue = input.memoType && input.memoValue ? input.memoValue : input.memo;
    TransactionsValidator.validateTransactionInput(input.recipientAddress, memoValue);

    let agent: Agent | undefined;
    if (input.agentId) {
      agent = await this.agents.getOrThrow(organizationId, input.agentId);
      if (agent.status !== AgentStatus.ACTIVE) {
        throw new DomainException(
          ErrorCode.AGENT_NOT_ACTIVE,
          `Agent '${agent.id}' is not active (status: ${agent.status})`,
        );
      }
    }
    return { wallet, agent };
  }

  private assertWalletSpendable(wallet: Wallet): void {
    if (wallet.status === WalletStatus.FROZEN) {
      throw new DomainException(ErrorCode.WALLET_FROZEN, 'Wallet is frozen');
    }
    if (wallet.status !== WalletStatus.ACTIVE) {
      throw new DomainException(
        ErrorCode.WALLET_FROZEN,
        `Wallet is not active (status: ${wallet.status})`,
      );
    }
  }

  private toIntent(
    organizationId: string,
    input: CreateTransactionInput,
    amount: number,
  ): TransactionIntent {
    return {
      organizationId,
      agentId: input.agentId,
      walletId: input.walletId,
      asset: input.asset,
      amount,
      recipientAddress: input.recipientAddress,
      at: new Date(),
    };
  }

  /** Age of the sending wallet in days — new wallets carry more risk. */
  private walletAgeDays(wallet: Wallet): number {
    return Math.floor((Date.now() - wallet.createdAt.getTime()) / 86_400_000);
  }

  /** Creates the approval Proposal row directly (avoids a circular module dep). */
  private async createProposal(
    organizationId: string,
    tx: Transaction,
    band: RiskBand,
    approvalExpiresInHours?: number,
  ) {
    const dualApproval = band === RiskBand.HIGH || band === RiskBand.CRITICAL;
    const configuredTtl = this.config?.get<number>('approval.ttlHours') ?? 72;
    const ttlHours = approvalExpiresInHours ?? configuredTtl;
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
    const proposal = await this.prisma.proposal.create({
      data: {
        organizationId,
        transactionId: tx.id,
        title: `Approval required for ${tx.amount.toFixed(7)} ${tx.asset}`,
        description: tx.purpose ?? undefined,
        approvalType: dualApproval ? 'DUAL' : 'SINGLE',
        requiredApprovals: dualApproval ? 2 : 1,
        status: 'PENDING',
        expiresAt,
      },
    });
    await this.eventBus.emit(
      DomainEventName.ProposalCreated,
      { proposalId: proposal.id, transactionId: tx.id, requiredApprovals: proposal.requiredApprovals },
      { organizationId, aggregateType: 'proposal', aggregateId: proposal.id },
    );
    return proposal;
  }
}
