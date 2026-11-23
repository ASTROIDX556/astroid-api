import { ApiKey } from '@prisma/client';
import { AuditEventPayload, AuditSnapshot, auditEvent } from '../../../events/audit-event.types';

/** Never includes the hash or the raw key — those must not reach the audit log. */
export function apiKeySnapshot(key: ApiKey): AuditSnapshot {
  return {
    name: key.name,
    prefix: key.prefix,
    scopes: key.scopes.join(','),
    allowedIps: key.allowedIps.join(','),
    expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
    revokedAt: key.revokedAt ? key.revokedAt.toISOString() : null,
  };
}

export function apiKeyCreatedAudit(key: ApiKey): AuditEventPayload {
  return auditEvent({
    action: 'api_key.created',
    resourceType: 'api_key',
    resourceId: key.id,
    summary: `Created API key '${key.name}'`,
    after: apiKeySnapshot(key),
  });
}

export function apiKeyUpdatedAudit(updated: ApiKey, before: ApiKey): AuditEventPayload {
  return auditEvent({
    action: 'api_key.updated',
    resourceType: 'api_key',
    resourceId: updated.id,
    summary: `Updated API key '${updated.name}'`,
    before: apiKeySnapshot(before),
    after: apiKeySnapshot(updated),
  });
}

export function apiKeyRevokedAudit(key: ApiKey): AuditEventPayload {
  return auditEvent({
    action: 'api_key.revoked',
    resourceType: 'api_key',
    resourceId: key.id,
    summary: `Revoked API key '${key.name}'`,
    after: apiKeySnapshot(key),
  });
}

export function apiKeyRotatedAudit(updated: ApiKey, before: ApiKey): AuditEventPayload {
  return auditEvent({
    action: 'api_key.rotated',
    resourceType: 'api_key',
    resourceId: updated.id,
    summary: `Rotated API key '${updated.name}'`,
    before: apiKeySnapshot(before),
    after: apiKeySnapshot(updated),
  });
}
