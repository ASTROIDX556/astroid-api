import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/** Persistence for Agent rows. */
@Injectable()
export class AgentRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.AgentCreateInput) {
    return this.prisma.agent.create({ data });
  }

  findById(organizationId: string, id: string) {
    return this.prisma.agent.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
  }

  /**
   * Finds a live agent by its handle (the display name) inside an organization.
   * Used to reject duplicate handles with a structured conflict error.
   */
  findByNameInOrg(organizationId: string, name: string, excludeId?: string) {
    return this.prisma.agent.findFirst({
      where: {
        organizationId,
        name,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  }

  async findManyAndCount(where: Prisma.AgentWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.agent.findMany({ where, ...pagination }),
      this.prisma.agent.count({ where }),
    ]);
    return { items, total };
  }

  update(id: string, data: Prisma.AgentUpdateInput) {
    return this.prisma.agent.update({ where: { id }, data });
  }

  softDelete(id: string) {
    return this.prisma.agent.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'ARCHIVED' },
    });
  }

  /** Confirms a wallet exists in the org and is assignable to an agent. */
  findWalletInOrg(organizationId: string, walletId: string) {
    return this.prisma.wallet.findFirst({
      where: { id: walletId, organizationId, deletedAt: null },
    });
  }
}
