import { Injectable } from '@nestjs/common';
import { Budget, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

type BudgetQueryClient = Pick<PrismaService, 'budget'> | Prisma.TransactionClient;

@Injectable()
export class BudgetRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.BudgetCreateInput): Promise<Budget> {
    return this.prisma.budget.create({ data });
  }

  async findManyAndCount(where: Prisma.BudgetWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.budget.findMany({ where, ...pagination }),
      this.prisma.budget.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string): Promise<Budget | null> {
    return this.prisma.budget.findFirst({ where: { id, organizationId, deletedAt: null } });
  }

  findChildren(parentBudgetId: string): Promise<Budget[]> {
    return this.prisma.budget.findMany({
      where: { parentBudgetId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  update(id: string, data: Prisma.BudgetUpdateInput): Promise<Budget> {
    return this.prisma.budget.update({ where: { id }, data });
  }

  incrementSpent(id: string, amount: Prisma.Decimal): Promise<Budget> {
    return this.prisma.budget.update({
      where: { id },
      data: { spent: { increment: amount } },
    });
  }

  async reserveBudget(organizationId: string, id: string, amount: Prisma.Decimal): Promise<Budget> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Budget[]>`SELECT * FROM "budgets" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;
      if (!rows || rows.length === 0) {
        throw new Error('NotFoundException');
      }
      
      const budget = rows[0];
      const spentAfter = new Prisma.Decimal(budget.spent).plus(amount);
      const limit = new Prisma.Decimal(budget.limitAmount);
      
      if (spentAfter.greaterThan(limit)) {
        throw new Error('ConflictException: BudgetExceeded');
      }
      
      return tx.budget.update({
        where: { id },
        data: { spent: spentAfter },
      });
    });
  }

  softDelete(id: string): Promise<Budget> {
    return this.prisma.budget.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
  }

  findEnabledByAgentId(agentId: string, client: BudgetQueryClient = this.prisma): Promise<Budget[]> {
    return client.budget.findMany({
      where: { agentId, enabled: true, deletedAt: null },
    });
  }
}
