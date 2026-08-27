import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/** Persistence for Policy rows. */
@Injectable()
export class PolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.PolicyCreateInput) {
    return this.prisma.policy.create({ data });
  }

  findById(organizationId: string, id: string) {
    return this.prisma.policy.findFirst({ where: { id, organizationId, deletedAt: null } });
  }

  /** Returns the enabled policies applicable to an org (and optionally an agent). */
  findActiveForEvaluation(organizationId: string, agentId?: string) {
    return this.prisma.policy.findMany({
      where: {
        organizationId,
        enabled: true,
        deletedAt: null,
        OR: [{ agentId: null }, ...(agentId ? [{ agentId }] : [])],
      },
      orderBy: { priority: 'asc' },
    });
  }

  /** Returns enabled policies for a specific agent (used for velocity checks). */
  findActiveForEvaluationByAgent(agentId: string) {
    return this.prisma.policy.findMany({
      where: {
        agentId,
        enabled: true,
        deletedAt: null,
      },
      orderBy: { priority: 'asc' },
    });
  }

  async findManyAndCount(where: Prisma.PolicyWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.policy.findMany({ where, ...pagination }),
      this.prisma.policy.count({ where }),
    ]);
    return { items, total };
  }

  update(id: string, data: Prisma.PolicyUpdateInput) {
    return this.prisma.policy.update({ where: { id }, data });
  }

  softDelete(id: string) {
    return this.prisma.policy.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
  }
}
