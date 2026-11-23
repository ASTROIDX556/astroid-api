import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';
import { CursorPayload } from '../../common/pagination/cursor-pagination';
import { AUDIT_CHAIN_GENESIS } from './audit-hash';

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
  requestId?: string | null;
  outcome?: string | null;
  sourceEventId?: string | null;
  createdAt?: Date;
  prevHash?: string | null;
  hash?: string | null;
}

/** Persistence for the append-only audit log. Writes and reads only — no updates. */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateAuditLogData) {
    const create = {
      organizationId: data.organizationId,
      userId: data.userId ?? null,
      action: data.action,
      entity: data.entity,
      entityId: data.entityId ?? null,
      oldValue: data.oldValue,
      newValue: data.newValue,
      ipAddress: data.ipAddress ?? null,
      device: data.device ?? null,
      requestId: data.requestId ?? null,
      outcome: data.outcome ?? null,
      sourceEventId: data.sourceEventId ?? null,
      prevHash: data.prevHash ?? null,
      hash: data.hash ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    };

    if (data.sourceEventId) {
      return this.prisma.auditLog.upsert({
        where: { sourceEventId: data.sourceEventId },
        create,
        update: {},
      });
    }

    return this.prisma.auditLog.create({ data: create });
  }

  /**
   * Appends an organization-scoped audit record atomically. Locking the stable
   * organization row serializes all writers for that chain; the last hash is
   * read and the new row inserted while the lock is held.
   */
  async createChained(
    data: CreateAuditLogData,
    computeHash: (id: string, prevHash: string, createdAt: Date) => string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "organizations" WHERE "id" = ${data.organizationId} FOR UPDATE
      `;

      const latest = await tx.auditLog.findFirst({
        where: { organizationId: data.organizationId, hash: { not: null } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { hash: true, createdAt: true },
      });
      const archive = latest
        ? null
        : await tx.auditLogArchive.findFirst({
            where: {
              organizationId: data.organizationId,
              chainBoundaryHash: { not: null },
            },
            orderBy: [{ archivedThrough: 'desc' }, { createdAt: 'desc' }],
            select: { chainBoundaryHash: true, archivedThrough: true },
          });
      const prevHash = latest?.hash ?? archive?.chainBoundaryHash ?? AUDIT_CHAIN_GENESIS;
      const id = uuidv7();
      const requestedTimestamp = data.createdAt ?? new Date();
      const previousTimestamp = latest?.createdAt ?? archive?.archivedThrough;
      const createdAt = previousTimestamp && requestedTimestamp <= previousTimestamp
        ? new Date(previousTimestamp.getTime() + 1)
        : requestedTimestamp;
      const hash = computeHash(id, prevHash, createdAt);
      const create = {
        id,
        organizationId: data.organizationId,
        userId: data.userId ?? null,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId ?? null,
        oldValue: data.oldValue,
        newValue: data.newValue,
        ipAddress: data.ipAddress ?? null,
        device: data.device ?? null,
        requestId: data.requestId ?? null,
        sourceEventId: data.sourceEventId ?? null,
        prevHash,
        hash,
        createdAt,
      };

      if (data.sourceEventId) {
        return tx.auditLog.upsert({
          where: { sourceEventId: data.sourceEventId },
          create,
          update: {},
        });
      }

      return tx.auditLog.create({ data: create });
    });
  }

  async findManyAndCount(where: Prisma.AuditLogWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, ...pagination }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Keyset page over `(createdAt, id)`. `order` selects the comparison
   * direction: `desc` for the newest-first listing, `asc` for resource
   * timelines. The cursor is a pure sort tuple, so it works even if the row it
   * came from was archived or deleted after the previous page was fetched.
   */
  findPage(
    where: Prisma.AuditLogWhereInput,
    cursor: CursorPayload | undefined,
    limit: number,
    order: 'asc' | 'desc' = 'desc',
  ) {
    const cursorWhere: Prisma.AuditLogWhereInput | undefined = cursor
      ? order === 'asc'
        ? {
            OR: [
              { createdAt: { gt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { gt: cursor.id } },
            ],
          }
        : {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
      : undefined;

    return this.prisma.auditLog.findMany({
      where: cursorWhere ? { AND: [where, cursorWhere] } : where,
      take: limit,
      orderBy: [{ createdAt: order }, { id: order }],
    });
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

  /**
   * Reads audit rows in bounded batches so exports do not load the full result
   * set into memory. The last row id is used as the next Prisma cursor.
   */
  async *streamLogs(
    where: Prisma.AuditLogWhereInput,
    batchSize: number,
    cursor?: string,
  ): AsyncGenerator<Prisma.AuditLogGetPayload<{
    include: { user: { select: { id: true; email: true; name: true } } };
  }>> {
    let nextCursor = cursor;

    while (true) {
      const records = await this.prisma.auditLog.findMany({
        where,
        take: batchSize,
        ...(nextCursor ? { cursor: { id: nextCursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

      if (records.length === 0) return;

      yield* records;
      if (records.length < batchSize) return;
      nextCursor = records[records.length - 1].id;
    }
  }

  findById(organizationId: string, id: string) {
    return this.prisma.auditLog.findFirst({ where: { id, organizationId } });
  }
}
