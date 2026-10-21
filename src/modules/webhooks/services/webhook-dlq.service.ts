import { Injectable, NotFoundException } from '@nestjs/common';

export interface DeadLetterWebhookRecord {
  id: string;
  organizationId: string;
  webhookId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attemptsMade: number;
  lastError: string;
  statusCode?: number;
  failedAt: Date;
  replayedAt?: Date | null;
}

export interface PaginatedDlqResult {
  items: DeadLetterWebhookRecord[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface WebhookDlqStore {
  findManyByOrganization(
    organizationId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: DeadLetterWebhookRecord[]; total: number }>;
  findById(organizationId: string, id: string): Promise<DeadLetterWebhookRecord | null>;
  markReplayed(id: string, replayedAt: Date): Promise<DeadLetterWebhookRecord>;
}

export interface WebhookReplayDispatcher {
  enqueueReplay(record: DeadLetterWebhookRecord): Promise<{ jobId: string }>;
}

@Injectable()
export class WebhookDlqService {
  constructor(
    private readonly store: WebhookDlqStore,
    private readonly dispatcher: WebhookReplayDispatcher,
  ) {}

  async listFailedDeliveries(
    organizationId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedDlqResult> {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const offset = (safePage - 1) * safeLimit;

    const { items, total } = await this.store.findManyByOrganization(
      organizationId,
      offset,
      safeLimit,
    );

    return {
      items,
      meta: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      },
    };
  }

  async replayDeadLetter(
    organizationId: string,
    dlqId: string,
  ): Promise<{ record: DeadLetterWebhookRecord; jobId: string }> {
    const existing = await this.store.findById(organizationId, dlqId);
    if (!existing) {
      throw new NotFoundException(`Dead-letter webhook record ${dlqId} not found`);
    }

    const { jobId } = await this.dispatcher.enqueueReplay(existing);
    const updated = await this.store.markReplayed(dlqId, new Date());
    return { record: updated, jobId };
  }
}
