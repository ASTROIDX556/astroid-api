import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION_KEY = 'astroid:auditAction';

/**
 * Overrides the audit log's `action` field with a semantic name (e.g.
 * `TRANSFER_FUNDS`, `POLICY_CREATED`, `AGENT_KEY_ROTATED`) instead of the
 * `AuditInterceptor`'s default `METHOD /url` action name.
 */
export const AuditAction = (action: string) => SetMetadata(AUDIT_ACTION_KEY, action);
