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
  /** Analytics roll-ups and precomputed aggregates. */
  Analytics: 'analytics',
  /** Long-running exports and scheduled reports. */
  Reports: 'reports',
  /** Periodic budget period reset cron job. */
  BudgetReset: 'budget-reset',
} as const;

export type QueueName = (typeof Queues)[keyof typeof Queues];
