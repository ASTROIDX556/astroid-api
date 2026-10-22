import { SetMetadata } from '@nestjs/common';

export const AUDIT_ACTION_KEY = 'astroid:auditAction';

/**
 * Options accepted by the {@link AuditAction} decorator.
 *
 * A bare action name is the common case (`@AuditAction('AGENT_KEY_ROTATED')`);
 * the object form additionally allows the audited entity and a human-readable
 * description of the operation to be recorded alongside the action.
 */
export interface AuditActionOptions {
  /** Semantic action name, e.g. `AGENT_KEY_ROTATED`. */
  action: string;
  /** Domain entity the action applies to, e.g. `Wallet`. */
  entity?: string;
  /** Human-readable description of the audited operation. */
  description?: string;
}

/** Normalized metadata stored under {@link AUDIT_ACTION_KEY}. */
export type AuditActionMetadata = AuditActionOptions;

/**
 * Marks a controller method (or a whole controller) as requiring an audit
 * trail.
 *
 * The decorator only stores metadata — it is the `StructuredAuditInterceptor`
 * that turns it into an `audit.recorded` event on the internal event bus.
 *
 * @example
 * ```ts
 * @AuditAction('AGENT_KEY_ROTATED')
 * @AuditAction({ action: 'AGENT_KEY_ROTATED', entity: 'ApiKey' })
 * ```
 */
export const AuditAction = (action: string | AuditActionOptions) =>
  SetMetadata(
    AUDIT_ACTION_KEY,
    typeof action === 'string' ? ({ action } satisfies AuditActionOptions) : action,
  );

/**
 * Normalizes whatever is stored under {@link AUDIT_ACTION_KEY} into a
 * {@link AuditActionOptions} object.
 *
 * Both the plain-string form (`'TRANSFER_FUNDS'`) and the object form are
 * accepted so metadata written by older revisions of the decorator — and by
 * hand-rolled `SetMetadata` calls — keeps working.
 *
 * @returns the normalized options, or `undefined` when the route is not
 * marked for auditing.
 */
export function normalizeAuditAction(value: unknown): AuditActionOptions | undefined {
  if (typeof value === 'string') {
    const action = value.trim();
    return action.length > 0 ? { action } : undefined;
  }

  if (value && typeof value === 'object') {
    const candidate = value as Partial<AuditActionOptions>;
    if (typeof candidate.action === 'string' && candidate.action.trim().length > 0) {
      return {
        action: candidate.action.trim(),
        ...(typeof candidate.entity === 'string' && candidate.entity.trim().length > 0
          ? { entity: candidate.entity.trim() }
          : {}),
        ...(typeof candidate.description === 'string' && candidate.description.trim().length > 0
          ? { description: candidate.description.trim() }
          : {}),
      };
    }
  }

  return undefined;
}
