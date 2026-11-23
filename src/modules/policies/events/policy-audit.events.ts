import { Policy } from '@prisma/client';
import { AuditEventPayload, AuditSnapshot, auditEvent } from '../../../events/audit-event.types';

/** Compact audit projection of a spending policy. Never includes configuration. */
export function policySnapshot(policy: Policy): AuditSnapshot {
  return {
    name: policy.name,
    type: policy.type,
    priority: policy.priority,
    enabled: policy.enabled,
    agentId: policy.agentId,
  };
}

export function policyCreatedAudit(policy: Policy): AuditEventPayload {
  return auditEvent({
    action: 'policy.created',
    resourceType: 'policy',
    resourceId: policy.id,
    summary: `Created spending policy '${policy.name}'`,
    after: policySnapshot(policy),
  });
}

export function policyUpdatedAudit(updated: Policy, before: Policy): AuditEventPayload {
  return auditEvent({
    action: 'policy.updated',
    resourceType: 'policy',
    resourceId: updated.id,
    summary: `Updated spending policy '${updated.name}'`,
    before: policySnapshot(before),
    after: policySnapshot(updated),
  });
}

export function policyDeletedAudit(policy: Policy): AuditEventPayload {
  return auditEvent({
    action: 'policy.deleted',
    resourceType: 'policy',
    resourceId: policy.id,
    summary: `Deleted spending policy '${policy.name}'`,
    before: policySnapshot(policy),
  });
}
