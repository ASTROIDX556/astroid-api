import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService, ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ApprovalDecision, Prisma, Proposal, ProposalStatus, Transaction } from '@prisma/client';
import { ApprovalRepository } from './approval.repository';
import { DecideProposalInput } from './approval.dto';
import { TransactionService } from '../transactions/transaction.service';
import { BudgetService } from '../budgets/budget.service';
import { DomainException } from '../../common/exceptions/domain.exception';
import { ErrorCode } from '../../common/constants/error-codes';
import {
  ConflictException,
  NotFoundException,
} from '../../common/exceptions/domain.exception';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { EventBusService } from '../../events/event-bus.service';
import { DomainEventName } from '../../events/event-names';
import {
  assertTransition,
  InvalidProposalTransitionException,
} from './approval-state-machine';
import { approvalConfig } from '../../config/approval.config';
import { idempotencyConfig, IdempotencyConfig } from '../../config/idempotency.config';
import { ApprovalIdempotencyRepository } from './approval-idempotency.repository';

const SORTABLE = ['createdAt', 'status', 'approvalType'];
const DECISION_OPERATION = 'approvals.decide';

type ProposalDetail = NonNullable<Awaited<ReturnType<ApprovalRepository['findById']>>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Maximum number of proposals a single sweep transitions. A bounded batch
 * keeps one tick from holding a database transaction open for too long; the
 * next tick picks up whatever is left.
 */
export const APPROVAL_EXPIRY_BATCH_SIZE = 500;

export interface ApprovalExpiryResult {
  /** Proposals this sweep actually moved to `EXPIRED`. */
  expired: number;
  /** Ids of the proposals that were transitioned (and emitted an event). */
  proposalIds: string[];
}

/**
 * Human-in-the-loop approval workflow for transactions that the pipeline flagged
 * as requiring sign-off. Collects approvals against a Proposal; once the
 * `requiredApprovals` threshold is met the underlying transaction is executed.
 * A single rejection rejects the whole proposal.
 *
 * Proposals can carry an `expiresAt`. Two mechanisms act on it:
 *  - {@link expireStale} is the janitor: a scheduled sweep moves expired
 *    pending proposals to the terminal `EXPIRED` state and emits
 *    `proposal.expired` for each transition.
 *  - {@link decide} is the guard: it refuses to act on an expired proposal
 *    (HTTP 409) even if the sweep has not run yet, and every terminal
 *    transition is a conditional `PENDING -> …` update so a decision racing
 *    the sweep can never leave a proposal both approved and expired.
 *
 * Expiry is always evaluated against the application clock (`new Date()` at
 * the call site), consistently in both the guard and the sweep, so clock skew
 * between app replicas can only ever delay or duplicate a sweep — the
 * conditional update resolves the outcome.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly repository: ApprovalRepository,
    private readonly transactions: TransactionService,
    private readonly eventBus: EventBusService,
    @Optional() private readonly budgets?: BudgetService,
    @Optional()
    @Inject(approvalConfig.KEY)
    private readonly approvalConfiguration?: ConfigType<typeof approvalConfig>,
    // Always provided by ApprovalModule (no @Optional, so DI fails loudly if it
    // is missing); typed optional only because it follows optional parameters.
    private readonly idempotency?: ApprovalIdempotencyRepository,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.ProposalWhereInput = { organizationId };
    if (query.filter) {
      where.status = query.filter as ProposalStatus;
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    await Promise.all(items.map((proposal) => this.expireIfNeeded(proposal, organizationId)));
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string) {
    const proposal = await this.repository.findById(organizationId, id);
    if (!proposal) {
      throw new NotFoundException('Proposal', id);
    }
    await this.expireIfNeeded(proposal, organizationId);
    return proposal;
  }

  /**
   * Records a reviewer's decision and advances the proposal state machine.
   *
   * Callers may pass an `Idempotency-Key`: the first request for a key reserves
   * a record, and repeats with the same key/payload either replay the stored
   * result or wait for the in-flight original. Reusing a key for different
   * payload (including a different proposal) is rejected with 409
   * `IDEMPOTENCY_KEY_MISMATCH`, matching docs/idempotency.md; records
   * expire after the configured retention window and are then treated as new.
   */
  async decide(
    organizationId: string,
    actorId: string,
    proposalId: string,
    input: DecideProposalInput,
    idempotency?: { principalId: string; key: string },
  ): Promise<ProposalDetail> {
    if (!idempotency) {
      return this.applyDecision(organizationId, actorId, proposalId, input);
    }
    if (!this.idempotency) {
      throw new Error('ApprovalIdempotencyRepository is not configured');
    }

    const { keyTtlMs, waitTimeoutMs, pollIntervalMs } = this.idempotencySettings();
    const reservationInput = {
      principalId: idempotency.principalId,
      operation: DECISION_OPERATION,
      keyHash: sha256(idempotency.key),
      requestHash: sha256(
        JSON.stringify({
          proposalId,
          decision: input.decision,
          comment: input.comment ?? null,
        }),
      ),
      expiresAt: new Date(Date.now() + keyTtlMs),
    };
    const reservation = await this.idempotency.reserve(reservationInput);

    if (!reservation.created) {
      if (reservation.record.requestHash !== reservationInput.requestHash) {
        throw new DomainException(
          ErrorCode.IDEMPOTENCY_KEY_MISMATCH,
          'Idempotency-Key was already used with a different approval decision payload',
        );
      }
      if (reservation.record.status === 'COMPLETED' && reservation.record.response !== null) {
        return this.replayStoredResponse(reservation.record.response);
      }

      const replayed = await this.waitForDecisionResult(
        reservationInput,
        waitTimeoutMs,
        pollIntervalMs,
      );
      if (replayed !== undefined) return this.replayStoredResponse(replayed);
      throw new ConflictException(
        'An approval decision with this Idempotency-Key is currently being processed; retry shortly',
      );
    }

    try {
      const result = await this.applyDecision(organizationId, actorId, proposalId, input);
      const response = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
      await this.idempotency.complete(
        reservation.record.id,
        response,
        new Date(Date.now() + keyTtlMs),
      );
      return result;
    } catch (error) {
      await this.idempotency.release(reservation.record.id);
      throw error;
    }
  }

  /** Applies the decision exactly once; callers handle idempotency around it. */
  private async applyDecision(
    organizationId: string,
    actorId: string,
    proposalId: string,
    input: DecideProposalInput,
  ): Promise<ProposalDetail> {
    // Do not use getOrThrow here: action-time expiry must itself own the
    // PENDING -> EXPIRED compare-and-set transition.
    const proposal = await this.repository.findById(organizationId, proposalId);
    if (!proposal) throw new NotFoundException('Proposal', proposalId);

    if (
      proposal.status === ProposalStatus.EXPIRED ||
      (proposal.expiresAt && proposal.expiresAt.getTime() <= Date.now())
    ) {
      if (proposal.status === ProposalStatus.PENDING) {
        await this.expireProposal(proposal, organizationId, actorId);
      }
      throw new DomainException(ErrorCode.PROPOSAL_EXPIRED, 'Proposal has expired');
    }
    if (proposal.status !== ProposalStatus.PENDING) {
      throw new InvalidProposalTransitionException(proposal.status, ProposalStatus.APPROVED);
    }

    const already = await this.repository.findApprovalByUser(proposalId, actorId);
    if (already) {
      throw new ConflictException('You have already voted on this proposal');
    }

    await this.repository.createApproval({
      proposalId,
      userId: actorId,
      decision: input.decision,
      comment: input.comment,
    });

    // A single rejection rejects the whole proposal. The conditional update
    // loses harmlessly if the sweeper expired the proposal in the meantime.
    if (input.decision === ApprovalDecision.REJECTED) {
      await this.transition(proposal, ProposalStatus.REJECTED, organizationId, actorId);
      await this.transactions.cancel(organizationId, actorId, proposal.transactionId);
      return this.getOrThrow(organizationId, proposalId);
    }

    const approvals = await this.repository.countApprovals(proposalId, 'APPROVED');
    if (approvals < proposal.requiredApprovals) {
      // Threshold not yet reached — remain pending.
      return this.getOrThrow(organizationId, proposalId);
    }

    // Threshold reached: approve, execute the transaction, then mark executed.
    await this.transition(proposal, ProposalStatus.APPROVED, organizationId, actorId, { approvals });

    await this.transactions.execute(organizationId, proposal.transactionId, actorId);
    await this.transition(
      { ...proposal, status: ProposalStatus.APPROVED },
      ProposalStatus.EXECUTED,
      organizationId,
      actorId,
    );

    return this.getOrThrow(organizationId, proposalId);
  }

  /**
   * Moves every pending proposal whose `expiresAt` is at or before `now` to
   * `EXPIRED`, emitting `proposal.expired` once per transition.
   *
   * The candidate read is only a hint: each write is a conditional
   * `updateMany(status = 'PENDING')`, so a proposal decided concurrently is
   * skipped (and emits nothing) instead of being overwritten. The returned
   * count is the number of rows this sweep actually changed.
   *
   * Called by the repeatable approval-expiry worker; also safe to invoke
   * directly (e.g. from a test or an admin command).
   */
  async expireStale(now: Date = new Date()): Promise<ApprovalExpiryResult> {
    const candidates = await this.repository.findExpiring(now, APPROVAL_EXPIRY_BATCH_SIZE);
    const proposalIds: string[] = [];

    for (const proposal of candidates) {
      const changed = await this.repository.expireIfPending(proposal.id);
      if (changed === 0) {
        // A reviewer decided (or a previous sweep expired) it in the meantime.
        continue;
      }

      proposalIds.push(proposal.id);

      if (this.budgets && proposal.transaction?.budgetId) {
        try {
          await this.budgets.releaseBudget(
            proposal.organizationId,
            proposal.transaction.budgetId,
            Number(proposal.transaction.amount),
          );
        } catch (error) {
          this.logger.warn(
            `Could not release budget for expired proposal ${proposal.id}: ${(error as Error).message}`,
          );
        }
      }

      if (proposal.transactionId) {
        try {
          await this.transactions.cancel(
            proposal.organizationId,
            'system:approval-sweep',
            proposal.transactionId,
          );
        } catch {
          // The transaction may already be terminal; expiry still succeeds.
        }
      }

      await this.eventBus.emit(
        DomainEventName.ProposalExpired,
        { proposalId: proposal.id, transactionId: proposal.transactionId },
        {
          organizationId: proposal.organizationId,
          aggregateType: 'proposal',
          aggregateId: proposal.id,
        },
      );
    }

    if (proposalIds.length > 0) {
      this.logger.log(
        `Expired ${proposalIds.length} pending approval proposal(s) past their expiresAt`,
      );
    }

    return { expired: proposalIds.length, proposalIds };
  }

  /**
   * Sweeps expired pending proposals in bounded batches.
   * Atomically transitions them to EXPIRED, releases held budgets, cancels transactions,
   * and emits ProposalExpired events.
   *
   * Idempotent under concurrency: conditional update guarantees budget is released exactly once.
   */
  async sweepExpired(batchSize?: number): Promise<{ scanned: number; expired: number }> {
    const limit = batchSize ?? this.approvalConfiguration?.sweepBatchSize ?? 100;
    const now = new Date();
    const candidates = await this.repository.findExpiredPending(now, limit);
    let expiredCount = 0;

    for (const proposal of candidates) {
      const transitioned = await this.expireProposal(proposal, proposal.organizationId);
      if (transitioned) {
        expiredCount++;
      }
    }

    this.logger.log(
      `Approval sweep completed: evaluated ${candidates.length} candidate(s), transitioned ${expiredCount} to EXPIRED`,
    );
    return { scanned: candidates.length, expired: expiredCount };
  }

  /**
   * Transitions a pending proposal atomically to EXPIRED and releases any held budget.
   * Guarantees idempotent single-execution: if another worker already transitioned
   * the proposal, this returns false and avoids double-releasing budget.
   */
  async expireProposal(
    proposal: Proposal & { transaction?: Transaction | null },
    organizationId: string,
    actorId = 'system:approval-sweep',
  ): Promise<boolean> {
    assertTransition(proposal.status, ProposalStatus.EXPIRED);

    // Conditional atomic compare-and-set: where: { id: proposal.id, status: PENDING }
    const changed = await this.repository.transitionStatus(
      proposal.id,
      ProposalStatus.PENDING,
      ProposalStatus.EXPIRED,
    );
    if (!changed) {
      return false; // raced with another worker or user decision
    }

    // Release held budget reservation exactly once
    if (this.budgets && proposal.transaction?.budgetId) {
      try {
        await this.budgets.releaseBudget(
          organizationId,
          proposal.transaction.budgetId,
          Number(proposal.transaction.amount),
        );
      } catch (err) {
        this.logger.warn(
          `Could not release budget for expired proposal ${proposal.id}: ${(err as Error).message}`,
        );
      }
    }

    // Cancel underlying transaction if still cancellable
    if (proposal.transactionId) {
      try {
        await this.transactions.cancel(organizationId, actorId, proposal.transactionId);
      } catch {
        // gracefully continue
      }
    }

    // Emit standard domain event
    await this.eventBus.emit(
      DomainEventName.ProposalExpired,
      { proposalId: proposal.id, transactionId: proposal.transactionId },
      { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposal.id },
    );

    return true;
  }

  /** Idempotency retention/wait settings, falling back to their env defaults. */
  private idempotencySettings(): IdempotencyConfig {
    return this.config?.get<IdempotencyConfig>('idempotency') ?? idempotencyConfig();
  }

  /** Rehydrates the response persisted on a completed idempotency record. */
  private replayStoredResponse(response: Prisma.JsonValue): ProposalDetail {
    return response as unknown as ProposalDetail;
  }

  /**
   * Polls an in-flight idempotency record until it completes, the wait window
   * elapses, or the reservation disappears (the original failed and released
   * it). A record that expired mid-wait is re-reserved and reported as
   * `created`; that abandoned reservation is released for the caller to retry.
   */
  private async waitForDecisionResult(
    reservationInput: Parameters<ApprovalIdempotencyRepository['reserve']>[0],
    waitTimeoutMs: number,
    pollIntervalMs: number,
  ): Promise<Prisma.JsonValue | undefined> {
    const idempotency = this.idempotency!;
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      const current = await idempotency.reserve(reservationInput);
      if (current.created) {
        await idempotency.release(current.record.id);
        return undefined;
      }
      if (current.record.status === 'COMPLETED' && current.record.response !== null) {
        return current.record.response;
      }
    }
    return undefined;
  }

  /** Expires stale proposals during reads as well as state-changing actions. */
  private async expireIfNeeded(
    proposal: Proposal & { transaction?: Transaction | null },
    organizationId: string,
  ): Promise<void> {
    if (proposal.status !== ProposalStatus.PENDING || !proposal.expiresAt || proposal.expiresAt >= new Date()) {
      return;
    }
    const transitioned = await this.expireProposal(proposal, organizationId);
    if (transitioned) {
      proposal.status = ProposalStatus.EXPIRED;
    }
  }

  /** The single service path for every Proposal status mutation and its event. */
  private async transition(
    proposal: Proposal,
    to: ProposalStatus,
    organizationId: string,
    actorId?: string,
    extra: { approvals?: number } = {},
  ): Promise<void> {
    assertTransition(proposal.status, to);
    const changed = await this.repository.transitionStatus(proposal.id, proposal.status, to);
    if (!changed) throw new InvalidProposalTransitionException(proposal.status, to);

    const options = { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposal.id };
    switch (to) {
      case ProposalStatus.APPROVED:
        await this.eventBus.emit(
          DomainEventName.ProposalApproved,
          { proposalId: proposal.id, transactionId: proposal.transactionId, ...extra },
          options,
        );
        return;
      case ProposalStatus.REJECTED:
        await this.eventBus.emit(
          DomainEventName.ProposalRejected,
          { proposalId: proposal.id, transactionId: proposal.transactionId },
          options,
        );
        return;
      case ProposalStatus.EXPIRED:
        await this.eventBus.emit(
          DomainEventName.ProposalExpired,
          { proposalId: proposal.id, transactionId: proposal.transactionId },
          options,
        );
        return;
      case ProposalStatus.EXECUTED:
        await this.eventBus.emit(
          DomainEventName.ProposalExecuted,
          { proposalId: proposal.id, transactionId: proposal.transactionId },
          options,
        );
        return;
      default:
        return;
    }
  }
}
