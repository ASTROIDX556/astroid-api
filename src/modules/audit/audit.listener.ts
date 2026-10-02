import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuditService } from './audit.service';
import { DomainEventEnvelope } from '../../events/domain-event.types';
import { DOMAIN_EVENT_ENVELOPE } from '../../events/domain-event.types';

/**
 * Subscribes to every domain event (wildcard) and appends an audit-log row.
 * Decoupled by design: a failure here must never affect the originating
 * transaction, so errors are swallowed and logged.
 */
@Injectable()
export class AuditListener {
  private readonly logger = new Logger(AuditListener.name);

  constructor(private readonly auditService: AuditService) {}

  @OnEvent(DOMAIN_EVENT_ENVELOPE)
  async handleDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    if (!envelope?.organizationId) {
      return;
    }
    try {
      await this.auditService.record({
        organizationId: envelope.organizationId,
        userId: envelope.actorId ?? null,
        action: envelope.name,
        entity: envelope.aggregateType,
        entityId: envelope.aggregateId ?? null,
        newValue: envelope.payload as object,
      });
    } catch (error) {
      this.logger.error(`Failed to write audit log for '${envelope.name}': ${(error as Error).message}`);
    }
  }
}
