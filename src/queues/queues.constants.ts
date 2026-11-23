/**
 * Named BullMQ queues. Heavy or asynchronous work is enqueued by the domain
 * modules; workers in `@workers/*` consume them with retry and backoff.
 */
export const Queues = {
  /** Outbound notification deliveries (email, webhook, slack, discord). */
  Notifications: 'notifications',
  /** Webhook retry attempts with exponential backoff. */
  Webhooks: 'webhooks',
  /** Permanently failed webhook deliveries, retained for inspection/replay. */
  WebhookDeadLetter: 'webhook-dead-letter',
  /** Periodic Stellar balance + state synchronization. */
  StellarSync: 'stellar-sync',
  /** Analytics roll-ups and precomputed aggregates. */
  Analytics: 'analytics',
  /** Long-running exports and scheduled reports. */
  Reports: 'reports',
} as const;

export type QueueName = (typeof Queues)[keyof typeof Queues];
