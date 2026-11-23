import { DomainEventNameType } from './event-names';

/**
 * The canonical envelope every emitted domain event is wrapped in. Carries
 * enough context (organization, actor, aggregate, correlation) to persist an
 * immutable ledger entry and to fan out to webhooks.
 */
export interface DomainEventEnvelope<TPayload = Record<string, unknown>> {
  name: DomainEventNameType;
  organizationId?: string;
  aggregateType: string;
  aggregateId?: string;
  actorId?: string;
  correlationId?: string;
  /** HTTP request that caused the event, when emitted inside a request. */
  requestId?: string | null;
  payload: TPayload;
  occurredAt: Date;
}

export interface WalletCreatedPayload {
  walletId: string;
  stellarAddress: string;
  walletType: string;
  agentId?: string;
}

export interface AgentRegisteredPayload {
  agentId: string;
  name: string;
  role: string;
}

export interface PolicyEvaluatedPayload {
  transactionId?: string;
  passed: boolean;
  violations: string[];
  requiresApproval: boolean;
}

export interface BudgetExceededPayload {
  budgetId: string;
  attempted: string;
  remaining: string;
}

export interface ProposalApprovedPayload {
  proposalId: string;
  transactionId: string;
  approvedBy: string;
}

export interface TransactionCompletedPayload {
  transactionId: string;
  stellarHash?: string;
  amount: string;
  asset: string;
}

export interface RiskEvaluatedPayload {
  transactionId?: string;
  score: number;
  band: string;
}
