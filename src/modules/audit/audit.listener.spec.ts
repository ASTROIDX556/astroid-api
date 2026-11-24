import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditListener } from './audit.listener';
import { AuditService } from './audit.service';
import { DomainEventEnvelope } from '../../events/domain-event.types';
import { DomainEventNameType } from '../../events/event-names';

/** Every named domain event from the issue that must yield an audit entry. */
const KEY_EVENTS: Array<[DomainEventNameType, string, string]> = [
  ['transaction.created', 'transaction', 'tx-1'],
  ['transaction.submitted', 'transaction', 'tx-1'],
  ['transaction.completed', 'transaction', 'tx-1'],
  ['transaction.failed', 'transaction', 'tx-1'],
  ['transaction.cancelled', 'transaction', 'tx-1'],
  ['policy.created', 'policy', 'policy-1'],
  ['policy.updated', 'policy', 'policy-1'],
  ['policy.deleted', 'policy', 'policy-1'],
  ['budget.created', 'budget', 'budget-1'],
  ['budget.updated', 'budget', 'budget-1'],
  ['budget.allocated', 'budget', 'budget-1'],
  ['budget.consumed', 'budget', 'budget-1'],
  ['proposal.approved', 'proposal', 'proposal-1'],
  ['proposal.rejected', 'proposal', 'proposal-1'],
  ['proposal.executed', 'proposal', 'proposal-1'],
];

describe('AuditListener', () => {
  let listener: AuditListener;
  let auditService: { record: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    auditService = { record: vi.fn().mockResolvedValue(undefined) };
    listener = new AuditListener(auditService as unknown as AuditService);
  });

  it('persists event identity, actor, timestamp, correlation, and outcome', async () => {
    const occurredAt = new Date('2026-09-28T12:00:00.000Z');
    const envelope: DomainEventEnvelope = {
      eventId: 'event-1',
      name: 'policy.violated',
      organizationId: 'org-1',
      actorId: 'user-1',
      aggregateType: 'agent',
      aggregateId: 'agent-1',
      correlationId: 'request-1',
      occurredAt,
      payload: { violation: 'daily-limit' },
    };

    await listener.handleDomainEvent(envelope);

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        userId: 'user-1',
        action: 'policy.violated',
        entity: 'agent',
        entityId: 'agent-1',
        sourceEventId: 'event-1',
        requestId: 'request-1',
        createdAt: occurredAt,
        newValue: expect.objectContaining({
          eventId: 'event-1',
          success: false,
          payload: { violation: 'daily-limit' },
        }),
      }),
    );
  });

  it('bounds large event payloads before persisting', async () => {
    const envelope: DomainEventEnvelope = {
      eventId: 'event-large',
      name: 'transaction.created',
      organizationId: 'org-1',
      aggregateType: 'transaction',
      occurredAt: new Date(),
      payload: { detail: 'x'.repeat(20_000) },
    };

    await listener.handleDomainEvent(envelope);

    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        newValue: expect.objectContaining({ eventId: 'event-large', truncated: true }),
      }),
    );
  });

  for (const [name, aggregateType, aggregateId] of KEY_EVENTS) {
    it(`persists a structured audit entry for ${name}`, async () => {
      const occurredAt = new Date('2026-09-28T12:00:00.000Z');
      const envelope: DomainEventEnvelope = {
        eventId: 'event-1',
        name,
        organizationId: 'org-1',
        actorId: 'user-1',
        aggregateType,
        aggregateId,
        correlationId: 'request-1',
        occurredAt,
        payload: { target: aggregateId },
      };

      await listener.handleDomainEvent(envelope);

      expect(auditService.record).toHaveBeenCalledTimes(1);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          userId: 'user-1',
          action: name,
          entity: aggregateType,
          entityId: aggregateId,
          sourceEventId: 'event-1',
          requestId: 'request-1',
          createdAt: occurredAt,
        }),
      );
    });
  }

  it('never propagates a persistence failure to the caller', async () => {
    auditService.record = vi.fn().mockRejectedValue(new Error('db down'));
    const envelope: DomainEventEnvelope = {
      eventId: 'event-1',
      name: 'transaction.completed',
      organizationId: 'org-1',
      aggregateType: 'transaction',
      occurredAt: new Date(),
      payload: { transactionId: 'tx-1' },
    };

    await expect(listener.handleDomainEvent(envelope)).resolves.toBeUndefined();
  });
});