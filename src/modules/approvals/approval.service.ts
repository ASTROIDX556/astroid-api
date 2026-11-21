import { Injectable, Logger } from '@nestjs/common';
import { ApprovalDecision, Prisma, ProposalStatus } from '@prisma/client';
import { ApprovalRepository } from './approval.repository';
import { DecideProposalInput } from './approval.dto';
import { TransactionService } from '../transactions/transaction.service';
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

const SORTABLE = ['createdAt', 'status', 'approvalType'];

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
  ) {}

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.ProposalWhereInput = { organizationId };
    if (query.filter) {
      where.status = query.filter as ProposalStatus;
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async getOrThrow(organizationId: string, id: string) {
    const proposal = await this.repository.findById(organizationId, id);
    if (!proposal) {
      throw new NotFoundException('Proposal', id);
    }
    return proposal;
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

  /** Records a reviewer's decision and advances the proposal state machine. */
  async decide(
    organizationId: string,
    actorId: string,
    proposalId: string,
    input: DecideProposalInput,
  ) {
    const proposal = await this.getOrThrow(organizationId, proposalId);

    if (proposal.status !== ProposalStatus.PENDING) {
      throw new DomainException(
        ErrorCode.PROPOSAL_NOT_PENDING,
        `Proposal is '${proposal.status}' and can no longer be decided`,
      );
    }
    if (proposal.expiresAt && proposal.expiresAt.getTime() <= Date.now()) {
      // The sweeper is a janitor, not the guard: expire it here if the sweep
      // has not run yet, then refuse the decision. Only emit when this call
      // actually performed the transition.
      const changed = await this.repository.expireIfPending(proposalId);
      if (changed > 0) {
        await this.eventBus.emit(
          DomainEventName.ProposalExpired,
          { proposalId, transactionId: proposal.transactionId },
          { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposalId },
        );
      }
      throw new DomainException(
        ErrorCode.PROPOSAL_EXPIRED,
        'Proposal has expired and can no longer be decided',
      );
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
      const changed = await this.repository.transitionFromPending(
        proposalId,
        ProposalStatus.REJECTED,
      );
      if (changed === 0) {
        throw new DomainException(
          ErrorCode.PROPOSAL_NOT_PENDING,
          `Proposal is no longer 'PENDING' and can no longer be decided`,
        );
      }
      await this.transactions.cancel(organizationId, actorId, proposal.transactionId);
      await this.eventBus.emit(
        DomainEventName.ProposalRejected,
        { proposalId, transactionId: proposal.transactionId },
        { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposalId },
      );
      return this.getOrThrow(organizationId, proposalId);
    }

    const approvals = await this.repository.countApprovals(proposalId, 'APPROVED');
    if (approvals < proposal.requiredApprovals) {
      // Threshold not yet reached — remain pending.
      return this.getOrThrow(organizationId, proposalId);
    }

    // Threshold reached: approve, execute the transaction, then mark executed.
    // The conditional transition guarantees a proposal the sweeper (or another
    // reviewer) already moved out of PENDING is never approved here, so it can
    // never be both APPROVED and EXPIRED.
    const changed = await this.repository.transitionFromPending(
      proposalId,
      ProposalStatus.APPROVED,
    );
    if (changed === 0) {
      throw new DomainException(
        ErrorCode.PROPOSAL_NOT_PENDING,
        `Proposal is no longer 'PENDING' and can no longer be decided`,
      );
    }
    await this.eventBus.emit(
      DomainEventName.ProposalApproved,
      { proposalId, transactionId: proposal.transactionId, approvals },
      { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposalId },
    );

    await this.transactions.execute(organizationId, proposal.transactionId, actorId);
    await this.repository.updateProposalStatus(proposalId, { status: ProposalStatus.EXECUTED });
    await this.eventBus.emit(
      DomainEventName.ProposalExecuted,
      { proposalId, transactionId: proposal.transactionId },
      { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposalId },
    );

    return this.getOrThrow(organizationId, proposalId);
  }
}
