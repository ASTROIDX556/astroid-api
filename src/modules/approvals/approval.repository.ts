import { Injectable } from '@nestjs/common';
import { Approval, Prisma, Proposal, ProposalStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/** Persistence for Proposal + Approval rows. */
@Injectable()
export class ApprovalRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findManyAndCount(where: Prisma.ProposalWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.proposal.findMany({
        where,
        ...pagination,
        include: { approvals: true, transaction: true },
      }),
      this.prisma.proposal.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string) {
    return this.prisma.proposal.findFirst({
      where: { id, organizationId },
      include: { approvals: true, transaction: true },
    });
  }

  /** A user may only vote once per proposal. */
  findApprovalByUser(proposalId: string, userId: string): Promise<Approval | null> {
    return this.prisma.approval.findFirst({ where: { proposalId, userId } });
  }

  createApproval(data: Prisma.ApprovalUncheckedCreateInput): Promise<Approval> {
    return this.prisma.approval.create({ data });
  }

  countApprovals(proposalId: string, decision: 'APPROVED' | 'REJECTED'): Promise<number> {
    return this.prisma.approval.count({ where: { proposalId, decision } });
  }

  updateProposalStatus(id: string, data: Prisma.ProposalUpdateInput): Promise<Proposal> {
    return this.prisma.proposal.update({ where: { id }, data });
  }

  /**
   * Pending proposals whose `expiresAt` has already passed, oldest first.
   * Used by the sweeper that moves stale approvals to their terminal state.
   */
  findExpiring(now: Date, limit: number): Promise<Proposal[]> {
    return this.prisma.proposal.findMany({
      where: { status: ProposalStatus.PENDING, expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Conditional `PENDING -> EXPIRED` transition. The `status` predicate makes
   * the write race safe: a proposal approved (or rejected) concurrently no
   * longer matches, so it is never both approved and expired.
   *
   * @returns the number of rows changed — 1 when this call won the race, 0 when
   * another writer already moved the proposal out of `PENDING`.
   */
  async expireIfPending(id: string): Promise<number> {
    const result = await this.prisma.proposal.updateMany({
      where: { id, status: ProposalStatus.PENDING },
      data: { status: ProposalStatus.EXPIRED },
    });
    return result.count;
  }

  /**
   * Conditional transition out of `PENDING` for the decision path, so a
   * decision that loses a race against the sweeper cannot re-open a terminal
   * proposal.
   *
   * @returns the number of rows changed (1 when the caller won, 0 otherwise).
   */
  async transitionFromPending(id: string, status: ProposalStatus): Promise<number> {
    const result = await this.prisma.proposal.updateMany({
      where: { id, status: ProposalStatus.PENDING },
      data: { status },
    });
    return result.count;
  }
}
