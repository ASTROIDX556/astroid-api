import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsOptions, Queue } from 'bullmq';

import { PrismaService } from '../../../database/prisma.service';
import { DEFAULT_WEBHOOK_CONFIG, WebhookConfig } from '../../../config/webhook.config';
import { Queues } from '../../../queues/queues.constants';
import {
  buildWebhookJobId,
  WEBHOOK_JOB_NAME,
  webhookJobOptionsFor,
} from '../../../queues/webhook.queue';
import { buildWebhookConcurrencyGroup, WebhookJobData } from '../types/webhook-job.types';
import { DeadLetterWebhookRecord, WebhookReplayDispatcher } from './webhook-dlq.service';

/** BullMQ states in which a job is already queued or executing. */
const IN_FLIGHT_STATES = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'paused',
  'waiting-children',
]);

/**
 * Re-enqueues a dead-lettered webhook delivery onto the real webhooks queue.
 *
 * A replay is an ordinary delivery job: it uses the same worker, the same
 * signing path, the same jittered retry policy and the same dead-letter path, so
 * a delivery that fails again is dead-lettered again instead of silently
 * disappearing. The only differences are the job id — a fresh one, because the
 * original failed job still holds the deterministic delivery id — and the
 * provenance recorded in the job metadata.
 *
 * Concurrency is protected twice: the deterministic delivery id is looked up and
 * the replay is refused with `409 Conflict` while another delivery of the same
 * event and subscription is waiting, delayed or active; and the replay job itself
 * has a stable id per delivery, so two operators clicking "replay" at the same
 * moment cannot both enqueue one.
 */
@Injectable()
export class WebhookDlqDispatcher implements WebhookReplayDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(Queues.Webhooks)
    private readonly webhookQueue: Queue<WebhookJobData>,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private get settings(): WebhookConfig {
    return this.config?.get<WebhookConfig>('webhook') ?? DEFAULT_WEBHOOK_CONFIG;
  }

  async enqueueReplay(record: DeadLetterWebhookRecord): Promise<{ jobId: string }> {
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: { id: record.id, organizationId: record.organizationId },
      include: { webhook: { select: { id: true, url: true, enabled: true } } },
    });
    if (!delivery) {
      throw new NotFoundException(`Dead-letter webhook record ${record.id} not found`);
    }
    if (delivery.status !== 'FAILED') {
      throw new ConflictException(
        `Delivery ${record.id} is not dead-lettered (status ${delivery.status})`,
      );
    }

    await this.assertNoDeliveryInFlight(delivery.eventId, delivery.webhookId);

    // Stable per delivery: a concurrent replay of the same dead-lettered record
    // is ignored by BullMQ instead of producing a second delivery.
    const jobId = `webhook-replay-${encodeURIComponent(delivery.id)}`;
    const existingReplay = await this.webhookQueue.getJob(jobId);
    if (existingReplay) {
      const state = await existingReplay.getState();
      if (IN_FLIGHT_STATES.has(state)) {
        throw new ConflictException(
          `Delivery ${record.id} is already being replayed (${state})`,
        );
      }
    }

    const data: WebhookJobData = {
      webhookId: delivery.webhookId,
      organizationId: delivery.organizationId,
      url: delivery.webhook.url,
      eventName: delivery.eventName,
      payload: delivery.payload as unknown,
      eventId: delivery.eventId,
      metadata: { requestId: `replay-${delivery.id}` },
    };

    const options: JobsOptions & { group?: string } = {
      ...webhookJobOptionsFor(this.settings),
      jobId,
      group: buildWebhookConcurrencyGroup(delivery.webhookId),
      // The in-flight guard above relies on the job record existing, so a
      // completed or failed replay is cleaned up and can be replayed again.
      removeOnComplete: true,
      removeOnFail: true,
    };
    await this.webhookQueue.add(WEBHOOK_JOB_NAME, data, options);

    return { jobId };
  }

  /** Refuses a replay while the same event/subscription pair is in flight. */
  private async assertNoDeliveryInFlight(eventId: string, webhookId: string): Promise<void> {
    const inFlight = await this.webhookQueue.getJob(buildWebhookJobId(eventId, webhookId));
    if (!inFlight) return;

    const state = await inFlight.getState();
    if (IN_FLIGHT_STATES.has(state)) {
      throw new ConflictException(
        `A delivery for event ${eventId} and subscription ${webhookId} is already ${state}`,
      );
    }
  }
}
