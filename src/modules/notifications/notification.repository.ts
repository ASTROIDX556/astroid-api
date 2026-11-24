import { Injectable } from '@nestjs/common';
import { Notification, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/** Persistence for Notification rows. */
@Injectable()
export class NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.NotificationUncheckedCreateInput): Promise<Notification> {
    return this.prisma.notification.create({ data });
  }

  /** Fan-out a notification to every active user in an organization. */
  createManyForOrg(data: Prisma.NotificationCreateManyInput[]): Promise<Prisma.BatchPayload> {
    return this.prisma.notification.createMany({ data });
  }

  findActiveUserIds(organizationId: string): Promise<{ id: string }[]> {
    return this.prisma.user.findMany({
      where: { organizationId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
  }

  async findManyAndCount(where: Prisma.NotificationWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({ where, ...pagination }),
      this.prisma.notification.count({ where }),
    ]);
    return { items, total };
  }

  countUnread(organizationId: string, userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { organizationId, userId, read: false } });
  }

  markRead(organizationId: string, userId: string, ids: string[]): Promise<Prisma.BatchPayload> {
    return this.prisma.notification.updateMany({
      where: { id: { in: ids }, organizationId, userId },
      data: { read: true },
    });
  }

  markAllRead(organizationId: string, userId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.notification.updateMany({
      where: { organizationId, userId, read: false },
      data: { read: true },
    });
  }
}
