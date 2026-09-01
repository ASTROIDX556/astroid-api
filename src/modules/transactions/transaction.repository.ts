import { Injectable } from 'nestjs/common';
import { Prisma, Transaction } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/** Persistence for Transaction rows plus risk-factor lookups. */
@Injectable()
export class TransactionRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.TransactionCreateInput): Promise<Transaction> {
    return this.prisma.transaction.create({ data });
  }

  async findManyAndCount(where: Prisma.TransactionWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({ where, ...pagination }),
      this.prisma.transaction.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string): Promise<Transaction | null> {
    return this.prisma.transaction.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
  }

  update(id: string, data: Prisma.TransactionUpdateInput): Promise<Transaction> {
    return this.prisma.transaction.update({ where: { id }, data });
  }

  /** True when this org has previously paid the given recipient successfully. */
  async hasPaidRecipient(organizationId: string, recipientAddress: string): Promise<boolean> {
    const count = await this.prisma.transaction.count({
      where: {
        organizationId,
        recipientAddress,
        status: { in: ['COMPLETED', 'CONFIRMED', 'SUBMITTED'] },
      },
    });
    return count > 0;
  }

  /** Number of transactions from a wallet within the trailing `sinceHours`. */
  recentCountForWallet(walletId: string, sinceHours = 24): Promise<number> {
    const since = new Date(Date.now() - sinceHours * 3_600_000);
    return this.prisma.transaction.count({
      where: { walletId, createdAt: { gte: since } },
    });
  }

  /**
   * Marks a transaction as failed due to network congestion when the dynamic fee
   * threshold is exceeded. This state is distinct from logical agent failures and
   * allows operators to manually retry after congestion subsides.
   */
  markFailedCongestion(id: string, estimatedFee: number): Promise<Transaction> {
    return this.prisma.transaction.update({
      where: { id },
      data: {
        status: 'FAILED_CONGESTION',
        estimatedFee,
      },
    });
  }

  /**
   * Records the actual fee charged after a transaction is submitted and confirmed.
   * This is used to track deviations from the estimated dynamic fee.
   */
  recordActualFee(id: string, actualFee: number): Promise<Transaction> {
    return this.prisma.transaction.update({
      where: { id },
      data: { actualFee },
    });
  }
}
