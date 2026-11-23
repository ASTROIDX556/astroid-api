import { Injectable } from '@nestjs/common';
import { Prisma, Webhook } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PrismaPagination } from '../../common/pagination';

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

  /** Delivery log for an organization, including permanently failed (DLQ) rows. */
  async findDeliveriesAndCount(
    where: Prisma.WebhookDeliveryWhereInput,
    pagination: PrismaPagination,
  ) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where,
        ...pagination,
        // The stored payload can be large; the log exposes attempt metadata only.
        select: {
          id: true,
          webhookId: true,
          eventName: true,
          eventId: true,
          status: true,
          attempts: true,
          lastError: true,
          lastStatusCode: true,
          lastAttemptAt: true,
          nextAttemptAt: true,
          deadLetteredAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.webhookDelivery.count({ where }),
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
}
