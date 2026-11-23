import { Injectable } from '@nestjs/common';
import { Prisma, Wallet } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/pagination';

/** Persistence for Wallet rows. Non-custodial: no secret is ever stored. */
@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.WalletCreateInput): Promise<Wallet> {
    return this.prisma.wallet.create({ data });
  }

  async findManyAndCount(where: Prisma.WalletWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.wallet.findMany({ where, ...pagination }),
      this.prisma.wallet.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string): Promise<Wallet | null> {
    return this.prisma.wallet.findFirst({ where: { id, organizationId, deletedAt: null } });
  }

  findByAddress(address: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { stellarAddress: address } });
  }

  update(id: string, data: Prisma.WalletUpdateInput): Promise<Wallet> {
    return this.prisma.wallet.update({ where: { id }, data });
  }

  softDelete(id: string): Promise<Wallet> {
    return this.prisma.wallet.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'ARCHIVED' },
    });
  }
}
