import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
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
    private readonly idempotency: ApprovalIdempotencyRepository,
    @Optional() private readonly config?: ConfigService,
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
   * Records a reviewer's decision and advances the proposal state machine.
   *
   * Callers may pass an `Idempotency-Key`: the first request for a key reserves
   * a record, and repeats with the same key/payload either replay the stored
   * result or wait for the in-flight original. Reusing a key for different
   * payload (including a different proposal) is rejected with 422; records
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
          ErrorCode.VALIDATION_ERROR,
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
    const proposal = await this.getOrThrow(organizationId, proposalId);

    if (proposal.status !== ProposalStatus.PENDING) {
      throw new DomainException(
        ErrorCode.PROPOSAL_NOT_PENDING,
        `Proposal is '${proposal.status}' and can no longer be decided`,
      );
    }
    if (proposal.expiresAt && proposal.expiresAt.getTime() < Date.now()) {
      await this.repository.updateProposalStatus(proposalId, { status: ProposalStatus.EXPIRED });
      await this.eventBus.emit(
        DomainEventName.ProposalExpired,
        { proposalId },
        { organizationId, actorId, aggregateType: 'proposal', aggregateId: proposalId },
      );
      throw new DomainException(ErrorCode.PROPOSAL_EXPIRED, 'Proposal has expired');
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
      await this.repository.updateProposalStatus(proposalId, { status: ProposalStatus.REJECTED });
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
    await this.repository.updateProposalStatus(proposalId, { status: ProposalStatus.APPROVED });
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
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      const current = await this.idempotency.reserve(reservationInput);
      if (current.created) {
        await this.idempotency.release(current.record.id);
        return undefined;
      }
      if (current.record.status === 'COMPLETED' && current.record.response !== null) {
        return current.record.response;
      }
    }
    return undefined;
  }
}
