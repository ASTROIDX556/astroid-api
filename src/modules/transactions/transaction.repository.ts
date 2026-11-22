import { Injectable } from '@nestjs/common';
import { Prisma, Transaction } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/**
 * Client accepted by the guarded status-transition reads/writes. Defaults to
 * the shared {@link PrismaService}; callers running inside a
 * `PrismaTransactionService` unit of work pass the transactional client so the
 * check and the update commit — or roll back — together.
 */
type TransactionWriteClient = PrismaService | Prisma.TransactionClient;

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

  findById(
    organizationId: string,
    id: string,
    client: TransactionWriteClient = this.prisma,
  ): Promise<Transaction | null> {
    return client.transaction.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
  }

  update(
    id: string,
    data: Prisma.TransactionUpdateInput,
    client: TransactionWriteClient = this.prisma,
  ): Promise<Transaction> {
    return client.transaction.update({ where: { id }, data });
  }
}
