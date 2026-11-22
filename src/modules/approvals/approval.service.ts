import { Injectable } from '@nestjs/common';
import { ApprovalDecision, Prisma, Proposal, ProposalStatus } from '@prisma/client';
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
import {
  assertTransition,
  InvalidProposalTransitionException,
} from './approval-state-machine';

const SORTABLE = ['createdAt', 'status', 'approvalType'];

/**
 * Human-in-the-loop approval workflow for transactions that the pipeline flagged
 * as requiring sign-off. Collects approvals against a Proposal; once the
 * `requiredApprovals` threshold is met the underlying transaction is executed.
 * A single rejection rejects the whole proposal.
 */
@Injectable()
export class ApprovalService {
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

  /** Records a reviewer's decision and advances the proposal state machine. */
  async decide(
    organizationId: string,
    actorId: string,
    proposalId: string,
    input: DecideProposalInput,
  ) {
    // Do not use getOrThrow here: action-time expiry must itself own the
    // PENDING -> EXPIRED compare-and-set transition.
    const proposal = await this.repository.findById(organizationId, proposalId);
    if (!proposal) throw new NotFoundException('Proposal', proposalId);

    if (proposal.expiresAt && proposal.expiresAt.getTime() < Date.now()) {
      await this.transition(proposal, ProposalStatus.EXPIRED, organizationId, actorId);
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

    // A single rejection rejects the whole proposal.
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

  /** Expires stale proposals during reads as well as state-changing actions. */
  private async expireIfNeeded(
    proposal: Proposal,
    organizationId: string,
  ): Promise<void> {
    if (proposal.status !== ProposalStatus.PENDING || !proposal.expiresAt || proposal.expiresAt >= new Date()) {
      return;
    }
    try {
      await this.transition(proposal, ProposalStatus.EXPIRED, organizationId);
      proposal.status = ProposalStatus.EXPIRED;
    } catch (error) {
      // Another concurrent reader/action already expired it; its event is authoritative.
      if (!(error instanceof InvalidProposalTransitionException)) throw error;
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
