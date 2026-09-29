import { Injectable } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Read-only aggregate queries powering dashboards and reporting. */
@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  countAgents(organizationId: string) {
    return this.prisma.agent.count({ where: { organizationId, deletedAt: null } });
  }

  countWallets(organizationId: string) {
    return this.prisma.wallet.count({ where: { organizationId, deletedAt: null } });
  }

  countPendingProposals(organizationId: string) {
    return this.prisma.proposal.count({ where: { organizationId, status: 'PENDING' } });
  }

  aggregateSpend(organizationId: string, since?: Date) {
    const where: Prisma.TransactionWhereInput = {
      organizationId,
      status: TransactionStatus.COMPLETED,
      deletedAt: null,
    };
    if (since) {
      where.createdAt = { gte: since };
    }
    return this.prisma.transaction.aggregate({
      where,
      _sum: { amount: true },
      _count: { _all: true },
      _avg: { riskScore: true },
    });
  }

  groupByStatus(organizationId: string) {
    return this.prisma.transaction.groupBy({
      by: ['status'],
      where: { organizationId, deletedAt: null },
      _count: { _all: true },
    });
  }

  groupByRiskBand(organizationId: string) {
    return this.prisma.transaction.groupBy({
      by: ['riskBand'],
      where: { organizationId, deletedAt: null },
      _count: { _all: true },
    });
  }

  spendByAgent(organizationId: string) {
    return this.prisma.transaction.groupBy({
      by: ['agentId'],
      where: {
        organizationId,
        status: TransactionStatus.COMPLETED,
        deletedAt: null,
        agentId: { not: null },
      },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
    });
  }
}
