import { z } from 'zod';

/** Query parameters for listing failed / dead-letter jobs. */
export const listDlqJobsQuerySchema = z.object({
  /** Target queue name filter. If omitted, queries across all registered queues. */
  queue: z.string().optional(),
  /** Page number for pagination (1-indexed). */
  page: z.coerce.number().int().positive().default(1),
  /** Number of items per page. */
  limit: z.coerce.number().int().positive().max(100).default(20),
  /** Zero-based start index (overrides page/limit if provided). */
  start: z.coerce.number().int().nonnegative().optional(),
  /** Zero-based end index (overrides page/limit if provided). */
  end: z.coerce.number().int().nonnegative().optional(),
});

export type ListDlqJobsQuery = z.infer<typeof listDlqJobsQuerySchema>;

/** Payload for retrying failed jobs. */
export const retryJobDtoSchema = z.object({
  /** Queue name if not supplied in path parameter. */
  queue: z.string().optional(),
});

export type RetryJobDto = z.infer<typeof retryJobDtoSchema>;

/** Payload for purging obsolete failed jobs. */
export const purgeDlqSchema = z.object({
  /** Queue name to purge. If omitted, purges across all queues. */
  queue: z.string().optional(),
  /** Grace period in milliseconds. Jobs failed more recently than this are kept. Defaults to 0 (purge all). */
  gracePeriodMs: z.coerce.number().int().nonnegative().default(0),
  /** Maximum number of jobs to purge in this invocation. Defaults to 1000. */
  limit: z.coerce.number().int().positive().max(10000).default(1000),
});

export type PurgeDlqDto = z.infer<typeof purgeDlqSchema>;

/** Detailed representation of a failed / DLQ job. */
export interface DlqJobDetails {
  id: string;
  name: string;
  queue: string;
  data: unknown;
  opts: Record<string, unknown>;
  failedReason?: string;
  stacktrace?: string[];
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  returnvalue?: unknown;
}

/** Queue summary statistics. */
export interface QueueJobCounts {
  queue: string;
  failed: number;
  active: number;
  waiting: number;
  delayed: number;
  completed: number;
  paused: number;
}
