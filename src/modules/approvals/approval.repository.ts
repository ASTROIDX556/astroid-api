import { Injectable } from '@nestjs/common';
import { Approval, Prisma, ProposalStatus } from '@prisma/client';
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

  /**
   * Finds pending proposals whose expiresAt timestamp is in the past,
   * bounded by the batch limit for safe streaming sweep execution.
   */
  findExpiredPending(now: Date, limit: number) {
    return this.prisma.proposal.findMany({
      where: {
        status: ProposalStatus.PENDING,
        expiresAt: { lte: now },
      },
      take: limit,
      include: { transaction: true, approvals: true },
      orderBy: { expiresAt: 'asc' },
    });
  }

  /**
   * Compare-and-set status transition. The database is the concurrency arbiter:
   * at most one caller observing `from` can win this mutation.
   */
  async transitionStatus(id: string, from: ProposalStatus, to: ProposalStatus): Promise<boolean> {
    const result = await this.prisma.proposal.updateMany({
      where: { id, status: from },
      data: { status: to },
    });
    return result.count === 1;
  }
}
