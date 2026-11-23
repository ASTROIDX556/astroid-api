/**
 * Named BullMQ queues. Heavy or asynchronous work is enqueued by the domain
 * modules; workers in `@workers/*` consume them with retry and backoff.
 */
export const Queues = {
  /** Outbound notification deliveries (email, webhook, slack, discord). */
  Notifications: 'notifications',
  /** Webhook retry attempts with exponential backoff. */
  Webhooks: 'webhooks',
  /** Periodic Stellar balance + state synchronization. */
  StellarSync: 'stellar-sync',
  /** Scheduled reconciliation of stored wallet balances against Stellar. */
  WalletReconciliation: 'wallet-reconciliation',
  /** Analytics roll-ups and precomputed aggregates. */
  Analytics: 'analytics',
  /** Long-running exports and scheduled reports. */
  Reports: 'reports',
  /** Transactional outbox fan-out jobs. */
  OutboxEvents: 'outbox-events',
  /** Stellar fee-bump submission retries. */
  StellarFeeBump: 'stellar-fee-bump',
  /** Transaction execution pipeline. */
  Transactions: 'transactions',
  /** Asynchronous risk evaluation and scoring. */
  RiskAnalysis: 'risk-analysis',
  /** Dead-letter queue for terminal job failures across all workers. */
  DeadLetter: 'dead-letter',
  /** Audit logs cleanup job. */
  AuditCleanup: 'audit-cleanup',
  /** Audit log archival: moves expired audit rows into the compressed archive. */
  AuditArchive: 'audit-archive',
  /** Periodic close/reopen of elapsed budget periods. */
  BudgetRollover: 'budget-rollover',
  /** Periodic removal of expired Idempotency-Key records. */
  IdempotencyCleanup: 'idempotency-cleanup',
  /** Scheduled sweep of expired approval requests to release reserved budget. */
  ApprovalSweep: 'approval-sweep',
} as const;

export type QueueName = (typeof Queues)[keyof typeof Queues];

/**
 * Correlation fields carried by a job so a worker failure can be tied back to
 * the request that caused it. Every field is optional on read: jobs enqueued
 * before these fields existed, and jobs enqueued outside a request (schedulers,
 * cron, seeds), do not have them. Producers always populate what the current
 * request context offers. Only ids are stored, never credentials.
 */
export interface QueueJobMetadata {
  requestId?: string;
  correlationId?: string;
  traceId?: string;
  /** The acting user (or agent) of the originating request. */
  actorId?: string;
  /** Id of the API key the originating request authenticated with. */
  apiKeyId?: string;
}

/** Standard payload stored when a job is dead-lettered. */
export interface DlqJobData {
  /** Original queue the job originated from. */
  originalQueue: string;
  /** Original BullMQ job ID. */
  originalJobId?: string;
  /** Original job name. */
  originalJobName?: string;
  /** Payload of the original failed job. */
  payload: unknown;
  /** Terminal failure reason or error message. */
  failedReason?: string;
  /** Stack trace if available. */
  stacktrace?: string[];
  /** Total retry attempts made before dead-lettering. */
  attemptsMade: number;
  /** ISO timestamp when job was dead-lettered. */
  failedAt: string;
  /** Additional metadata (organizationId, transactionId, etc.). */
  metadata?: Record<string, unknown>;
}