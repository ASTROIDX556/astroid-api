import {
  BadRequestException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';
import { WebhookRepository } from './webhook.repository';
import { CreateWebhookInput, UpdateWebhookInput } from './webhook.dto';
import { ConflictException, NotFoundException } from '../../common/exceptions/domain.exception';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import {
  buildPaginationMeta,
  PaginationQuery,
  toPrismaPagination,
} from '../../common/helpers/pagination';
import { Paginated } from '../../common/interfaces/api-response.interface';
import { CursorPaginated } from '../../common/interfaces/api-response.interface';
import { CursorPaginationQuery, decodeCursor, encodeCursor } from '../../common/pagination/cursor-pagination';
import { generateToken } from '../../utils/crypto.util';
import { WebhookDestinationPolicy, WebhookDestinationError } from './webhook-destination.policy';
import { EncryptionService } from '../../common/encryption/encryption.service';

const SORTABLE = ['createdAt', 'url'];

/** Strips the signing secret from a webhook before returning it to a client. */
function redact<T extends { secret?: string }>(webhook: T): Omit<T, 'secret'> {
  const { secret: _secret, ...safe } = webhook;
  return safe;
}

/**
 * Manages outbound webhook subscriptions. Each webhook has an HMAC signing
 * secret that is returned ONLY when it is created or rotated — it is never
 * logged and never included in any list/get response afterwards.
 */
@Injectable()
export class WebhookService {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly destinationPolicy: WebhookDestinationPolicy,
    @Optional() private readonly encryptionService?: EncryptionService,
    @Optional() private readonly deliveryService?: WebhookDeliveryService,
  ) {}

  async create(organizationId: string, input: CreateWebhookInput) {
    await this.validateDestination(input.url);
    const secret = `whsec_${generateToken(24)}`;
    const storedSecret = this.encryptionService ? this.encryptionService.encrypt(secret) : secret;
    const webhook = await this.repository.create({
      organizationId,
      url: input.url,
      secret: storedSecret,
      events: input.events,
      enabled: input.enabled,
    });
    // Return the secret exactly once, alongside the redacted record.
    return { ...redact(webhook), secret };
  }

  async list(organizationId: string, query: PaginationQuery) {
    const where: Prisma.WebhookWhereInput = { organizationId };
    if (query.search) {
      where.url = { contains: query.search, mode: 'insensitive' };
    }
    const pagination = toPrismaPagination(query, SORTABLE);
    const { items, total } = await this.repository.findManyAndCount(where, pagination);
    return new Paginated(items, buildPaginationMeta(total, query));
  }

  async listDeliveries(
    organizationId: string,
    query: CursorPaginationQuery & { status?: WebhookDeliveryStatus },
  ) {
    const rows = await this.repository.findDeliveryPage(
      organizationId,
      query.cursor ? decodeCursor(query.cursor) : undefined,
      query.limit + 1,
      query.status,
    );
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];
    return new CursorPaginated(items, { limit: query.limit, hasMore, nextCursor: hasMore && last ? encodeCursor(last) : null });
  }

  /**
   * Re-enqueues a dead-lettered delivery exactly once.
   *
   * The transition out of `DEAD_LETTER` is a guarded `updateMany`, so when two
   * operators replay the same delivery concurrently only one wins the claim and
   * enqueues a job; the other receives a 409. If enqueueing fails, the delivery
   * is put back in `DEAD_LETTER` so it stays inspectable and replayable.
   */
  async replayDeadLetterDelivery(organizationId: string, id: string) {
    const delivery = await this.repository.findDeliveryById(organizationId, id);
    if (!delivery) {
      throw new NotFoundException('Webhook delivery', id);
    }
    if (delivery.status !== WebhookDeliveryStatus.DEAD_LETTER) {
      throw new ConflictException(
        `Webhook delivery ${id} is ${delivery.status}; only DEAD_LETTER deliveries can be replayed`,
      );
    }
    if (!this.deliveryService) {
      throw new ServiceUnavailableException('Webhook delivery queue is not configured');
    }

    const claimed = await this.repository.claimDeadLetterForReplay(organizationId, id);
    if (claimed === 0) {
      throw new ConflictException(`Webhook delivery ${id} is already being replayed`);
    }

    try {
      await this.deliveryService.queueDelivery({
        webhookId: delivery.webhookId,
        organizationId: delivery.organizationId,
        url: delivery.webhook.url,
        eventName: delivery.eventName,
        eventId: delivery.eventId,
        payload: delivery.payload,
      });
    } catch (error) {
      await this.repository.restoreDeadLetter(organizationId, id).catch(() => undefined);
      throw error;
    }

    return {
      id: delivery.id,
      webhookId: delivery.webhookId,
      eventName: delivery.eventName,
      status: WebhookDeliveryStatus.PENDING,
      replayed: true,
    };
  }

  async getOrThrow(organizationId: string, id: string) {
    const webhook = await this.repository.findById(organizationId, id);
    if (!webhook) {
      throw new NotFoundException('Webhook', id);
    }
    return webhook;
  }

  async get(organizationId: string, id: string) {
    return redact(await this.getOrThrow(organizationId, id));
  }

  async update(organizationId: string, id: string, input: UpdateWebhookInput) {
    await this.getOrThrow(organizationId, id);
    if (input.url) await this.validateDestination(input.url);
    const webhook = await this.repository.update(id, {
      url: input.url,
      events: input.events,
      enabled: input.enabled,
    });
    return redact(webhook);
  }

  /** Rotates the signing secret; the new secret is returned exactly once. */
  async rotateSecret(organizationId: string, id: string) {
    await this.getOrThrow(organizationId, id);
    const secret = `whsec_${generateToken(24)}`;
    const storedSecret = this.encryptionService ? this.encryptionService.encrypt(secret) : secret;
    const webhook = await this.repository.update(id, { secret: storedSecret });
    return { ...redact(webhook), secret };
  }

  async remove(organizationId: string, id: string) {
    await this.getOrThrow(organizationId, id);
    await this.repository.delete(id);
    return { id, deleted: true };
  }

  private async validateDestination(url: string): Promise<void> {
    try {
      await this.destinationPolicy.validate(url);
    } catch (error) {
      if (error instanceof WebhookDestinationError) {
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException('Webhook destination is not allowed');
    }
  }
}
