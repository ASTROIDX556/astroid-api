import type { JobsOptions } from 'bullmq';
import { buildJobOptions } from './queue-policy';

/** Name of the repeatable budget rollover job and of manual on-demand runs. */
export const BUDGET_ROLLOVER_JOB_NAME = 'budget-rollover';

export interface BudgetRolloverJobData {
  trigger: 'scheduled' | 'manual';
  /** ISO timestamp of the tick that enqueued the job. */
  requestedAt?: string;
  /** Optional per-job override of the configured page size. */
  batchSize?: number;
}

export const budgetRolloverJobOptions: JobsOptions = buildJobOptions({
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 100 },
});
