import { ApprovalDecision } from '@prisma/client';
import { AuditEventPayload, auditEvent } from '../../../events/audit-event.types';

export interface ApprovalDecisionAuditInput {
  proposalId: string;
  transactionId: string;
  decision: ApprovalDecision;
  comment?: string;
  approvedCount: number;
  requiredApprovals: number;
}

/** Audit payload for a single reviewer decision on a proposal (#547). */
export function approvalDecidedAudit(input: ApprovalDecisionAuditInput): AuditEventPayload {
  return auditEvent({
    action: 'approval.decided',
    resourceType: 'proposal',
    resourceId: input.proposalId,
    summary: `Recorded ${input.decision} decision on proposal ${input.proposalId}`,
    after: {
      decision: input.decision,
      comment: input.comment ?? null,
      approvedCount: input.approvedCount,
      requiredApprovals: input.requiredApprovals,
      transactionId: input.transactionId,
    },
  });
}
