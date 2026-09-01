import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { Queues } from './queues.constants';
import { DlqProcessor } from './dlq.processor';

/**
 * Central queue plumbing. The BullMQ connections and named queues are provisioned
 * once here so domain modules can inject publishers and workers can attach
 * processors without re-establishing Redis each time.
 *
 * The concrete BullMQ registration is intentionally thin — the queue tokens
 * below are the public surface every worker uses.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: Queues.DeadLetter,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 5_000 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    }),
  ],
  providers: [DlqProcessor],
  exports: [BullModule, DlqProcessor],
})
export class QueueModule {}

/** Symbol tokens for typed queue injection across modules. */
export const QueueTokens = {
  Notifications: Symbol.for('queue:notifications'),
  Webhooks: Symbol.for('queue:webhooks'),
  StellarSync: Symbol.for('queue:stellar-sync'),
  Analytics: Symbol.for('queue:analytics'),
  Reports: Symbol.for('queue:reports'),
  Transactions: Symbol.for('queue:transactions'),
  RiskAnalysis: Symbol.for('queue:risk-analysis'),
  DeadLetter: Symbol.for('queue:dead-letter'),
} as const;

/** Default job options for every queue: bounded retries with backoff. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
} as const;

