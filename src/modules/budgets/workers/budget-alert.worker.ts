import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType } from '@prisma/client';

import {
  DOMAIN_EVENT_ENVELOPE,
  DomainEventEnvelope,
} from '../../../events/domain-event.types';
import { DomainEventName } from '../../../events/event-names';
import { BudgetAlertRepository } from '../budget-alert.repository';
import { NotificationService } from '../../notifications/notification.service';

interface BudgetThresholdReachedData {
  budgetId?: string;
  period?: string;
  periodStart?: string;
  threshold?: number;
  usage?: string;
  limit?: string;
  utilisation?: string;
  currency?: string;
}

/**
 * Notification consumer for budget threshold alerts.
 *
 * The event is emitted by `BudgetAlertService` after the spend has already been
 * committed, so this handler can never roll the spend back. Consumption is
 * idempotent: the ledger row is claimed with a conditional
 * `UPDATE … WHERE notifiedAt IS NULL`, so re-delivered events (or two workers
 * racing) create the notification records exactly once.
 */
@Injectable()
export class BudgetAlertWorker {
  private readonly logger = new Logger(BudgetAlertWorker.name);

  constructor(
    private readonly alerts: BudgetAlertRepository,
    private readonly notifications: NotificationService,
  ) {}

  // Consuming the canonical envelope (like the audit and webhook listeners) is
  // what carries the organization context; the per-name channel only carries
  // the bare payload.
  @OnEvent(DOMAIN_EVENT_ENVELOPE)
  async onThresholdReached(envelope: DomainEventEnvelope): Promise<void> {
    try {
      await this.handle(envelope);
    } catch (error) {
      // Never let a notification failure surface as a failed spend.
      this.logger.error(
        `Failed to consume budget threshold alert: ${(error as Error).message}`,
      );
    }
  }

  async handle(envelope: DomainEventEnvelope): Promise<boolean> {
    if (envelope.name !== DomainEventName.BudgetThresholdReached) return false;
    const data = envelope.payload as BudgetThresholdReachedData;
    if (!envelope.organizationId || !data.budgetId || data.threshold === undefined) {
      return false;
    }

    const periodStart = data.periodStart ? new Date(data.periodStart) : new Date();
    const alert = await this.alerts.findByPeriod(data.budgetId, periodStart, data.threshold);
    if (!alert || alert.organizationId !== envelope.organizationId) return false;

    const claimed = await this.alerts.markNotified(alert.id);
    if (!claimed) return false;

    const threshold = data.threshold;
    await this.notifications.broadcast(envelope.organizationId, {
      title:
        threshold >= 100
          ? `Budget limit reached (${threshold}%)`
          : `Budget threshold reached (${threshold}%)`,
      body:
        `A budget reached ${data.utilisation ?? threshold}% of its limit ` +
        `(${data.usage ?? '0'} of ${data.limit ?? '0'} ${data.currency ?? ''}`.trim() +
        `).`,
      type: NotificationType.BUDGET_EXCEEDED,
      metadata: {
        event: envelope.name,
        budgetId: data.budgetId,
        period: data.period,
        periodStart: periodStart.toISOString(),
        threshold,
        usage: data.usage,
        limit: data.limit,
        currency: data.currency,
      },
    });
    return true;
  }

}
