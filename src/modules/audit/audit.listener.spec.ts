import { describe, expect, it, vi } from 'vitest';
import { AuditListener } from './audit.listener';
import { AuditService } from './audit.service';
import { DomainEventEnvelope } from '../../events/domain-event.types';
import { DomainEventName } from '../../events/event-names';
import { AuditEventPayload } from '../../events/audit-event.types';

function envelope(payload: Record<string, unknown>): DomainEventEnvelope {
  return {
    name: DomainEventName.PolicyCreated,
    organizationId: 'org_1',
    aggregateType: 'policy',
    aggregateId: 'pol_1',
    actorId: 'user_1',
    requestId: 'req_envelope',
    payload,
    occurredAt: new Date('2026-11-23T00:00:00.000Z'),
  };
}

const auditPayload: AuditEventPayload = {
  action: 'policy.updated',
  resourceType: 'policy',
  resourceId: 'pol_1',
  summary: "Updated spending policy 'Max spend'",
  before: { name: 'Old', enabled: true },
  after: { name: 'Max spend', enabled: false },
  requestId: 'req_42',
};

describe('AuditListener', () => {
  const record = vi.fn().mockResolvedValue(undefined);
  const listener = new AuditListener({ record } as unknown as AuditService);

  it('persists a typed audit payload as actor/resource/action/before/after/requestId', async () => {
    await listener.handleDomainEvent(envelope(auditPayload as unknown as Record<string, unknown>));

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      organizationId: 'org_1',
      userId: 'user_1',
      action: 'policy.updated',
      entity: 'policy',
      entityId: 'pol_1',
      oldValue: { name: 'Old', enabled: true },
      newValue: { name: 'Max spend', enabled: false },
      requestId: 'req_42',
    });
  });

  it('falls back to a generic audit row for non-audit domain events', async () => {
    record.mockClear();
    await listener.handleDomainEvent(
      envelope({ transactionId: 'tx_1', amount: '10' }),
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: DomainEventName.PolicyCreated,
        entity: 'policy',
        entityId: 'pol_1',
        oldValue: undefined,
        newValue: { transactionId: 'tx_1', amount: '10' },
        requestId: 'req_envelope',
      }),
    );
  });

  it('ignores events without an organization', async () => {
    record.mockClear();
    await listener.handleDomainEvent({
      ...envelope(auditPayload as unknown as Record<string, unknown>),
      organizationId: undefined,
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('swallows persistence failures so the originating mutation is unaffected', async () => {
    record.mockRejectedValueOnce(new Error('db down'));
    await expect(
      listener.handleDomainEvent(envelope(auditPayload as unknown as Record<string, unknown>)),
    ).resolves.toBeUndefined();
  });
});
