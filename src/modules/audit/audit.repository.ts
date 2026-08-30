import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

export interface CreateAuditLogData {
  organizationId: string;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: Prisma.InputJsonValue;
  newValue?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  device?: string | null;
  previousHash?: string | null;
  hash?: string | null;
}

/** Persistence for the append-only audit log. Writes and reads only — no updates. */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateAuditLogData) {
    return this.prisma.auditLog.create({
      data: {
        organizationId: data.organizationId,
        userId: data.userId ?? null,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId ?? null,
        oldValue: data.oldValue,
        newValue: data.newValue,
        ipAddress: data.ipAddress ?? null,
        device: data.device ?? null,
        previousHash: data.previousHash ?? null,
        hash: data.hash ?? null,
      },
    });
  }

  async findManyAndCount(where: Prisma.AuditLogWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, ...pagination }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total };
  }

  async exportLogs(
    where: Prisma.AuditLogWhereInput,
    limit: number,
    cursor?: string,
  ) {
    return this.prisma.auditLog.findMany({
      where,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });
  }

  findById(organizationId: string, id: string) {
    return this.prisma.auditLog.findFirst({ where: { id, organizationId } });
  }
}
