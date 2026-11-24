import { Injectable } from '@nestjs/common';
import { Prisma, Webhook } from '@prisma/client';
import { CursorPayload } from '../../common/pagination/cursor-pagination';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/helpers/pagination';

/**
 * Persistence for Webhook rows. The `secret` column is never selected into list
 * responses — it is only returned inline on create/rotate.
 */
@Injectable()
export class WebhookRepository {
  private static readonly SAFE_SELECT = {
    id: true,
    organizationId: true,
    url: true,
    events: true,
    enabled: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.WebhookSelect;

  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.WebhookUncheckedCreateInput): Promise<Webhook> {
    return this.prisma.webhook.create({ data });
  }

  async findManyAndCount(where: Prisma.WebhookWhereInput, pagination: PrismaPagination) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.webhook.findMany({ where, ...pagination, select: WebhookRepository.SAFE_SELECT }),
      this.prisma.webhook.count({ where }),
    ]);
    return { items, total };
  }

  findById(organizationId: string, id: string): Promise<Webhook | null> {
    return this.prisma.webhook.findFirst({ where: { id, organizationId } });
  }

  /** All enabled webhooks in an org subscribed to a given event name. */
  findEnabledForEvent(organizationId: string, event: string): Promise<Webhook[]> {
    return this.prisma.webhook.findMany({
      where: { organizationId, enabled: true, events: { has: event } },
    });
  }

  update(id: string, data: Prisma.WebhookUpdateInput): Promise<Webhook> {
    return this.prisma.webhook.update({ where: { id }, data });
  }

  delete(id: string): Promise<Webhook> {
    return this.prisma.webhook.delete({ where: { id } });
  }

  findDeliveryPage(organizationId: string, cursor: CursorPayload | undefined, take: number) {
    const cursorWhere: Prisma.WebhookDeliveryWhereInput | undefined = cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : undefined;
    return this.prisma.webhookDelivery.findMany({ where: cursorWhere ? { AND: [{ organizationId }, cursorWhere] } : { organizationId }, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  }
}
