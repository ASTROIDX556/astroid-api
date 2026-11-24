import { Injectable } from '@nestjs/common';
import { MemoryRecord, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/** Persistence for the financial memory ledger. */
@Injectable()
export class MemoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.MemoryRecordUncheckedCreateInput): Promise<MemoryRecord> {
    return this.prisma.memoryRecord.create({ data });
  }

  async findManyAndCount(where: Prisma.MemoryRecordWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.memoryRecord.findMany({ where, ...pagination }),
      this.prisma.memoryRecord.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string): Promise<MemoryRecord | null> {
    return this.prisma.memoryRecord.findFirst({ where: { id, organizationId } });
  }
}
