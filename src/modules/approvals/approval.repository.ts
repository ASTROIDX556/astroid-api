import { Injectable } from '@nestjs/common';
import { Approval, Prisma, Proposal } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/pagination';

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
}
