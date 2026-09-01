import { Injectable } from '@nestjs/common';
import { Prisma, Transaction } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../common/helpers/pagination';

/** Status used when a transaction is blocked due to network congestion. */
export const TRANSACTION_STATUS_FAILED_CONGESTION = 'FAILED_CONGESTION';

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

  /**
   * Marks a transaction as blocked due to network congestion.
   * This is a protective state: the transaction is not considered failed
   * due to a logical error, but suspended until an operator can retry.
   */
  markAsCongestionBlocked(id: string, estimatedFee: number): Promise<Transaction> {
    return this.update(id, {
      status: TRANSACTION_STATUS_FAILED_CONGESTION,
      estimatedFee,
    });
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
}
