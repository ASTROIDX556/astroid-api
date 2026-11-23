import { TraceContext } from '../common/context/trace.context';

/**
 * Typed audit contract (#547). A governance mutation emits exactly one of these
 * payloads on the shared event bus after the database write succeeds. The audit
 * listener recognises the shape and persists it as a first-class audit row
 * (actor, resource, action, before/after, request id) instead of dumping the
 * raw event payload.
 *
 * Keep payloads small and serialisable: only audit-relevant fields, never full
 * entities and never secrets.
 */

export const AuditResourceType = {
  Policy: 'policy',
  Budget: 'budget',
  Proposal: 'proposal',
  ApiKey: 'api_key',
} as const;

export type AuditResourceType =
  (typeof AuditResourceType)[keyof typeof AuditResourceType];

/** A compact, JSON-safe projection of an entity for the audit trail. */
export type AuditSnapshot = Record<string, string | number | boolean | null>;

export type AuditEventPayload = {
  /** Dot.case action, e.g. `policy.created`. */
  action: string;
  resourceType: AuditResourceType;
  resourceId: string;
  /** Human-readable one-liner for the audit UI. */
  summary: string;
  /** State before the mutation, or null for creates. */
  before: AuditSnapshot | null;
  /** State after the mutation, or null for deletes. */
  after: AuditSnapshot | null;
  /** Correlates with the HTTP request that caused the mutation. */
  requestId: string | null;
};

export interface AuditEventInput {
  action: string;
  resourceType: AuditResourceType;
  resourceId: string;
  summary: string;
  before?: AuditSnapshot | null;
  after?: AuditSnapshot | null;
}

/**
 * Builds an audit payload, stamping the request id from the active trace
 * context when one is available.
 */
export function auditEvent(input: AuditEventInput): AuditEventPayload {
  return {
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    summary: input.summary,
    before: input.before ?? null,
    after: input.after ?? null,
    requestId: TraceContext.getTraceId() ?? null,
  };
}

/** Narrowing helper used by the audit listener. */
export function isAuditEventPayload(payload: unknown): payload is AuditEventPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.action === 'string' &&
    typeof candidate.resourceType === 'string' &&
    typeof candidate.resourceId === 'string' &&
    typeof candidate.summary === 'string' &&
    'before' in candidate &&
    'after' in candidate
  );
}
