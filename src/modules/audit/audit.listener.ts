import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditService } from './audit.service';
import { DomainEventEnvelope } from '../../events/domain-event.types';
import { isAuditEventPayload } from '../../events/audit-event.types';

/**
 * Subscribes to every domain event (wildcard) and appends an audit-log row.
 * Governance mutations emit a typed audit payload (see `src/events/audit-event.types.ts`);
 * those are persisted with their own action, resource, before/after snapshots
 * and request id. Any other domain event still gets a generic audit row so no
 * event is silently dropped from the trail.
 *
 * Decoupled by design: a failure here must never affect the originating
 * transaction, so errors are swallowed and logged.
 */
@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name);

  constructor(private readonly auditService: AuditService) {}

  @OnEvent('**')
  async handleDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    if (!envelope?.organizationId) {
      return;
    }
    try {
      const audit = isAuditEventPayload(envelope.payload) ? envelope.payload : undefined;
      await this.auditService.record({
        organizationId: envelope.organizationId,
        userId: envelope.actorId ?? null,
        action: audit?.action ?? envelope.name,
        entity: audit?.resourceType ?? envelope.aggregateType,
        entityId: audit?.resourceId ?? envelope.aggregateId ?? null,
        oldValue: audit?.before ?? undefined,
        newValue: audit
          ? (audit.after ?? { summary: audit.summary })
          : (envelope.payload as object),
        requestId: audit?.requestId ?? envelope.requestId ?? null,
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for '${envelope.name}': ${(error as Error).message}`,
      );
    }
  }
}
