import { Budget } from '@prisma/client';
import { AuditEventPayload, AuditSnapshot, auditEvent } from '../../../events/audit-event.types';

/** Compact audit projection of a budget. Amounts are strings to keep 7-dp. */
export function budgetSnapshot(budget: Budget): AuditSnapshot {
  return {
    name: budget.name,
    currency: budget.currency,
    limitAmount: budget.limitAmount.toFixed(7),
    spent: budget.spent.toFixed(7),
    period: budget.period,
    enabled: budget.enabled,
    parentBudgetId: budget.parentBudgetId,
    agentId: budget.agentId,
  };
}

export function budgetCreatedAudit(budget: Budget): AuditEventPayload {
  return auditEvent({
    action: 'budget.created',
    resourceType: 'budget',
    resourceId: budget.id,
    summary: `Created budget '${budget.name}'`,
    after: budgetSnapshot(budget),
  });
}

export function budgetUpdatedAudit(updated: Budget, before: Budget): AuditEventPayload {
  return auditEvent({
    action: 'budget.updated',
    resourceType: 'budget',
    resourceId: updated.id,
    summary: `Updated budget '${updated.name}'`,
    before: budgetSnapshot(before),
    after: budgetSnapshot(updated),
  });
}

export function budgetDeletedAudit(budget: Budget): AuditEventPayload {
  return auditEvent({
    action: 'budget.deleted',
    resourceType: 'budget',
    resourceId: budget.id,
    summary: `Deleted budget '${budget.name}'`,
    before: budgetSnapshot(budget),
  });
}
