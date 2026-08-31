import { z } from 'zod';

/**
 * Zod schema for the time-range filter used in failed job queries.
 */
export const timeRangeFilterSchema = z
  .object({
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
  })
  .optional();

export type TimeRangeFilterDto = z.infer<typeof timeRangeFilterSchema>;

/**
 * Zod schema for listing failed jobs with advanced filtering.
 */
export const listFailedJobsFilterSchema = z.object({
  /** Target queue name. If omitted, queries all registered queues. */
  queue: z.string().optional(),
  /** Filter by failed reason containing this substring (case-insensitive). */
  reasonContains: z.string().max(200).optional(),
  /** Filter by BullMQ job name. */
  jobName: z.string().max(200).optional(),
  /** Filter by time range (epoch ms). */
  timeRange: timeRangeFilterSchema,
  /** Page number (1-indexed). */
  page: z.coerce.number().int().positive().default(1),
  /** Items per page (max 100). */
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type ListFailedJobsFilterDto = z.infer<typeof listFailedJobsFilterSchema>;

/**
 * Zod schema for batch retry requests. Uses the same filter as listing,
 * but with a higher default limit.
 */
export const batchRetryFilterSchema = z.object({
  queue: z.string().optional(),
  reasonContains: z.string().max(200).optional(),
  jobName: z.string().max(200).optional(),
  timeRange: timeRangeFilterSchema,
  limit: z.coerce.number().int().positive().max(10_000).default(1000),
});

export type BatchRetryFilterDto = z.infer<typeof batchRetryFilterSchema>;

/**
 * Zod schema for batch purge requests.
 */
export const batchPurgeFilterSchema = z.object({
  queue: z.string().optional(),
  reasonContains: z.string().max(200).optional(),
  jobName: z.string().max(200).optional(),
  timeRange: timeRangeFilterSchema,
  limit: z.coerce.number().int().positive().max(10_000).default(1000),
});

export type BatchPurgeFilterDto = z.infer<typeof batchPurgeFilterSchema>;

/**
 * Zod schema for inspecting a specific job.
 */
export const inspectJobParamsSchema = z.object({
  queue: z.string().min(1, 'Queue name is required'),
  id: z.string().min(1, 'Job ID is required'),
});

export type InspectJobParamsDto = z.infer<typeof inspectJobParamsSchema>;
