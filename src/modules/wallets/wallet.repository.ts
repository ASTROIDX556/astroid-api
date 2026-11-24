import { Injectable } from '@nestjs/common';
import { Prisma, Wallet, WalletStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/** The wallet fields reconciliation needs; no secrets, no unrelated columns. */
export type WalletReconciliationTarget = Pick<
  Wallet,
  'id' | 'organizationId' | 'stellarAddress' | 'network' | 'balance'
>;

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

  /**
   * Wallets eligible for balance reconciliation: ACTIVE only. Archived,
   * frozen, paused and soft-deleted wallets are excluded. The `status` index
   * already serves this predicate, so the scan never touches inactive rows.
   */
  findActiveForReconciliation(): Promise<WalletReconciliationTarget[]> {
    return this.prisma.wallet.findMany({
      where: { status: WalletStatus.ACTIVE, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        stellarAddress: true,
        network: true,
        balance: true,
      },
      orderBy: { id: 'asc' },
    });
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
