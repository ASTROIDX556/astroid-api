import { Injectable } from '@nestjs/common';
import { Prisma, Webhook, WebhookDelivery, WebhookDeliveryStatus } from '@prisma/client';
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

  findDeliveryPage(
    organizationId: string,
    cursor: CursorPayload | undefined,
    take: number,
    status?: WebhookDeliveryStatus,
  ) {
    const conditions: Prisma.WebhookDeliveryWhereInput[] = [{ organizationId }];
    if (status) conditions.push({ status });
    if (cursor) {
      conditions.push({
        OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
      });
    }
    return this.prisma.webhookDelivery.findMany({
      where: conditions.length === 1 ? conditions[0] : { AND: conditions },
      take,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** One delivery, scoped to its organization, with the endpoint URL needed to replay it. */
  findDeliveryById(
    organizationId: string,
    id: string,
  ): Promise<(WebhookDelivery & { webhook: { url: string } }) | null> {
    return this.prisma.webhookDelivery.findFirst({
      where: { id, organizationId },
      include: { webhook: { select: { url: true } } },
    });
  }

  /**
   * Atomically moves a delivery out of the dead-letter state before a replay is
   * enqueued. The `status` predicate makes the transition single-winner: two
   * concurrent replays can never enqueue the same delivery twice.
   */
  async claimDeadLetterForReplay(organizationId: string, id: string): Promise<number> {
    const result = await this.prisma.webhookDelivery.updateMany({
      where: { id, organizationId, status: WebhookDeliveryStatus.DEAD_LETTER },
      data: { status: WebhookDeliveryStatus.PENDING, nextRetryAt: null },
    });
    return result.count;
  }

  /** Returns a delivery to the dead-letter state when its replay cannot be queued. */
  async restoreDeadLetter(organizationId: string, id: string): Promise<void> {
    await this.prisma.webhookDelivery.updateMany({
      where: { id, organizationId, status: WebhookDeliveryStatus.PENDING },
      data: { status: WebhookDeliveryStatus.DEAD_LETTER },
    });
  }
}
