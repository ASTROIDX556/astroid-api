import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';

import { AuditRecordedPayload } from '../../events/domain-event.types';
import { DomainEventName } from '../../events/event-names';
import { RequestContext } from '../../common/context/request-context';
import { AuditService } from './audit.service';

/**
 * Turns the `audit.recorded` events published by the
 * `StructuredAuditInterceptor` into immutable audit-log rows.
 *
 * The interceptor only publishes the event — the persistence happens here, so
 * the request/response cycle is never delayed by the audit write. A failure to
 * write the row is logged and swallowed: an audit outage must not break the
 * operation that was being audited.
 */
@Injectable()
export class AuditRecordedListener {
  private readonly logger = new Logger(AuditRecordedListener.name);

  constructor(private readonly auditService: AuditService) {}

  @OnEvent(DomainEventName.AuditRecorded)
  async handleAuditRecorded(payload: AuditRecordedPayload): Promise<void> {
    if (!payload?.action) {
      return;
    }

    const organizationId =
      payload.organizationId ?? RequestContext.getStore()?.principal?.organizationId;

    if (!organizationId) {
      this.logger.warn(
        `Skipping audit event '${payload.action}': the event carries no organization context`,
      );
      return;
    }

    try {
      await this.auditService.record({
        organizationId,
        userId: payload.userId ?? null,
        action: payload.action,
        entity: payload.entity ?? 'http',
        entityId: payload.entityId ?? null,
        newValue: this.toAuditValue(payload),
        ipAddress: payload.ipAddress ?? null,
        device: payload.userAgent ?? null,
        requestId: payload.requestId ?? null,
        createdAt: payload.occurredAt ? new Date(payload.occurredAt) : undefined,
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for '${payload.action}': ${(error as Error).message}`,
      );
    }
  }

  /** Projects the event payload onto the JSON column of the audit row. */
  private toAuditValue(payload: AuditRecordedPayload): Prisma.InputJsonValue {
    return {
      method: payload.method,
      url: payload.url,
      statusCode: payload.statusCode,
      success: payload.success,
      durationMs: payload.durationMs,
      agentId: payload.agentId ?? null,
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.body !== undefined ? { body: payload.body } : {}),
      ...(payload.params !== undefined ? { params: payload.params } : {}),
      ...(payload.query !== undefined ? { query: payload.query } : {}),
    } as Prisma.InputJsonValue;
  }
}
