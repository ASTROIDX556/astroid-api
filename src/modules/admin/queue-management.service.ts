import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Job } from 'bullmq';
import { redisConfig } from '../../config/redis.config';
import { Queues } from '../../queues/queues.constants';

/**
 * Time-range filter for failed jobs. Jobs whose `finishedOn` timestamp falls
 * within [from, to] are included.
 */
export interface TimeRangeFilter {
  /** Include jobs finished after this epoch ms. */
  from?: number;
  /** Include jobs finished before this epoch ms. */
  to?: number;
}

/**
 * Filter options for querying failed jobs across queues.
 */
export interface FailedJobFilter {
  /** Target queue name. If omitted, queries all registered queues. */
  queue?: string;
  /** Filter by failed reason containing this substring (case-insensitive). */
  reasonContains?: string;
  /** Filter by job name. */
  jobName?: string;
  /** Filter by time range of job completion. */
  timeRange?: TimeRangeFilter;
  /** Page number (1-indexed). */
  page?: number;
  /** Items per page (max 100). */
  limit?: number;
}

/**
 * Result of a batch retry operation.
 */
export interface BatchRetryResult {
  retriedCount: number;
  failedCount: number;
  skippedCount: number;
  queues: string[];
  retriedJobIds: string[];
  errors: Array<{ jobId: string; queue: string; error: string } | { queue: string; error: string }>;
}

/**
 * Result of a batch purge operation.
 */
export interface BatchPurgeResult {
  purgedCount: number;
  queues: string[];
  removedJobIds: string[];
  errors: Array<{ queue: string; error: string }>;
}

/**
 * Snapshot of queue health for operational monitoring.
 */
export interface QueueHealthSnapshot {
  queue: string;
  failed: number;
  active: number;
  waiting: number;
  delayed: number;
  completed: number;
  paused: number;
  totalProcessed: number;
  oldestFailedJobTimestamp?: number;
  newestFailedJobTimestamp?: number;
}

/**
 * Detailed view of a single failed job for inspection purposes.
 */
export interface FailedJobInspection {
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
  /** Derived status based on attempts vs configured max. */
  status: 'failed' | 'exhausted' | 'unrecoverable';
  /** Elapsed time between processing and failure in ms. */
  processingDurationMs?: number;
}

/**
 * Queue management service providing enhanced dead-letter queue operations.
 *
 * Builds on top of the BullMQ queue APIs to provide:
 *   - Paginated listing of failed jobs with rich filtering (by queue, reason
 *     substring, job name, time range)
 *   - Detailed job inspection with derived metadata
 *   - Batch retry and purge operations with granular error reporting
 *   - Queue health snapshots for operational dashboards
 *
 * All inputs are validated at the controller layer via Zod schemas; this
 * service trusts its inputs and focuses on Redis queue manipulation.
 */
@Injectable()
export class QueueManagementService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueManagementService.name);
  private readonly queueHandles = new Map<string, Queue>();

  /** Lazily creates or retrieves a BullMQ Queue handle by name. */
  private getOrCreateQueue(queueName: string): Queue {
    let queue = this.queueHandles.get(queueName);
    if (!queue) {
      const { host, port, password, db } = redisConfig();
      queue = new Queue(queueName, {
        connection: { host, port, password: password || undefined, db },
      });
      this.queueHandles.set(queueName, queue);
    }
    return queue;
  }

  /** Returns all known queue names including any dynamically accessed queues. */
  private getAllQueueNames(): string[] {
    return Array.from(
      new Set([...Object.values(Queues), ...this.queueHandles.keys()]),
    );
  }

  // ---------------------------------------------------------------------------
  // Inspection & Filtering
  // ---------------------------------------------------------------------------

  /**
   * Lists failed jobs with optional filtering by queue, failed reason, job name,
   * and time range. Results are paginated and sorted by `finishedOn` descending.
   */
  async listFailedJobs(filter: FailedJobFilter): Promise<{
    items: FailedJobInspection[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = filter.page ?? 1;
    const limit = Math.min(filter.limit ?? 20, 100);
    const targetQueues = filter.queue ? [filter.queue] : this.getAllQueueNames();

    let allJobs: Array<{ job: Job; queueName: string }> = [];

    for (const qName of targetQueues) {
      try {
        const queue = this.getOrCreateQueue(qName);
        const failedJobs = await queue.getFailed(0, 10_000);
        for (const job of failedJobs) {
          allJobs.push({ job, queueName: qName });
        }
      } catch (err) {
        this.logger.warn(`Failed to load failed jobs from queue '${qName}': ${(err as Error).message}`);
      }
    }

    // Apply filters
    allJobs = allJobs.filter(({ job }) => {
      if (filter.jobName && job.name !== filter.jobName) {
        return false;
      }

      if (filter.reasonContains) {
        const reason = job.failedReason?.toLowerCase() ?? '';
        if (!reason.includes(filter.reasonContains.toLowerCase())) {
          return false;
        }
      }

      if (filter.timeRange) {
        const finishedOn = job.finishedOn ?? job.timestamp;
        if (filter.timeRange.from && finishedOn < filter.timeRange.from) {
          return false;
        }
        if (filter.timeRange.to && finishedOn > filter.timeRange.to) {
          return false;
        }
      }

      return true;
    });

    // Sort by finishedOn descending (newest first)
    allJobs.sort(
      (a, b) => (b.job.finishedOn ?? b.job.timestamp) - (a.job.finishedOn ?? a.job.timestamp),
    );

    const total = allJobs.length;
    const start = (page - 1) * limit;
    const paginated = allJobs.slice(start, start + limit);

    return {
      items: paginated.map(({ job, queueName }) => this.buildInspection(job, queueName)),
      total,
      page,
      limit,
    };
  }

  /**
   * Inspects a specific failed job in a named queue, returning enriched metadata
   * including derived status and processing duration.
   */
  async inspectJob(queueName: string, jobId: string): Promise<FailedJobInspection> {
    const queue = this.getOrCreateQueue(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      throw new NotFoundException(
        `Job '${jobId}' not found in queue '${queueName}'`,
      );
    }

    return this.buildInspection(job, queueName);
  }

  // ---------------------------------------------------------------------------
  // Batch Operations
  // ---------------------------------------------------------------------------

  /**
   * Retries failed jobs matching the given filter. Returns granular results
   * including per-job success/failure counts.
   */
  async batchRetry(filter: FailedJobFilter): Promise<BatchRetryResult> {
    const limit = filter.limit ?? 1000;
    const targetQueues = filter.queue ? [filter.queue] : this.getAllQueueNames();

    const result: BatchRetryResult = {
      retriedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      queues: [],
      retriedJobIds: [],
      errors: [],
    };

    for (const qName of targetQueues) {
      try {
        const queue = this.getOrCreateQueue(qName);
        const failedJobs = await queue.getFailed(0, limit);

        for (const job of failedJobs) {
          // Apply filters
          if (filter.jobName && job.name !== filter.jobName) {
            result.skippedCount++;
            continue;
          }
          if (filter.reasonContains) {
            const reason = job.failedReason?.toLowerCase() ?? '';
            if (!reason.includes(filter.reasonContains.toLowerCase())) {
              result.skippedCount++;
              continue;
            }
          }
          if (filter.timeRange) {
            const finishedOn = job.finishedOn ?? job.timestamp;
            if (filter.timeRange.from && finishedOn < filter.timeRange.from) {
              result.skippedCount++;
              continue;
            }
            if (filter.timeRange.to && finishedOn > filter.timeRange.to) {
              result.skippedCount++;
              continue;
            }
          }

          try {
            await job.retry();
            result.retriedCount++;
            result.retriedJobIds.push(String(job.id));
          } catch (err) {
            result.failedCount++;
            result.errors.push({
              jobId: String(job.id),
              queue: qName,
              error: (err as Error).message,
            });
          }
        }

        result.queues.push(qName);
      } catch (err) {
        result.errors.push({
          queue: qName,
          error: (err as Error).message,
        });
      }
    }

    this.logger.log(
      `Batch retry: ${result.retriedCount} retried, ${result.failedCount} failed, ${result.skippedCount} skipped`,
    );

    return result;
  }

  /**
   * Purges (permanently removes) failed jobs matching the given filter.
   * Returns granular results including per-queue purge counts.
   */
  async batchPurge(filter: FailedJobFilter): Promise<BatchPurgeResult> {
    const limit = filter.limit ?? 1000;
    const targetQueues = filter.queue ? [filter.queue] : this.getAllQueueNames();

    const result: BatchPurgeResult = {
      purgedCount: 0,
      queues: [],
      removedJobIds: [],
      errors: [],
    };

    for (const qName of targetQueues) {
      try {
        const queue = this.getOrCreateQueue(qName);
        // BullMQ Queue.clean() with 0 grace period removes all failed jobs
        // up to the specified limit
        const removedIds = await queue.clean(0, limit, 'failed');
        result.purgedCount += removedIds.length;
        result.removedJobIds.push(...removedIds);
        result.queues.push(qName);
      } catch (err) {
        result.errors.push({
          queue: qName,
          error: (err as Error).message,
        });
      }
    }

    this.logger.log(
      `Batch purge: ${result.purgedCount} jobs removed from ${result.queues.length} queues`,
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // Health & Diagnostics
  // ---------------------------------------------------------------------------

  /**
   * Returns a health snapshot for every registered queue, including job counts,
   * total processed jobs, and timestamps of oldest/newest failed jobs.
   */
  async getQueueHealth(): Promise<QueueHealthSnapshot[]> {
    const allQueueNames = this.getAllQueueNames();

    return Promise.all(
      allQueueNames.map(async (qName) => {
        const queue = this.getOrCreateQueue(qName);
        try {
          const counts = await queue.getJobCounts(
            'failed',
            'active',
            'waiting',
            'delayed',
            'completed',
            'paused',
          );

          const totalProcessed =
            (counts.completed ?? 0) + (counts.failed ?? 0) + (counts.active ?? 0);

          // Get timestamps of oldest and newest failed jobs
          let oldestFailedJobTimestamp: number | undefined;
          let newestFailedJobTimestamp: number | undefined;

          if (counts.failed > 0) {
            const failedJobs = await queue.getFailed(0, 0);
            if (failedJobs.length > 0) {
              oldestFailedJobTimestamp = failedJobs[0].finishedOn ?? failedJobs[0].timestamp;
            }

            const newestFailed = await queue.getFailed(0, 0);
            if (newestFailed.length > 0) {
              newestFailedJobTimestamp =
                newestFailed[newestFailed.length - 1].finishedOn ??
                newestFailed[newestFailed.length - 1].timestamp;
            }
          }

          return {
            queue: qName,
            failed: counts.failed ?? 0,
            active: counts.active ?? 0,
            waiting: counts.waiting ?? 0,
            delayed: counts.delayed ?? 0,
            completed: counts.completed ?? 0,
            paused: counts.paused ?? 0,
            totalProcessed,
            oldestFailedJobTimestamp,
            newestFailedJobTimestamp,
          };
        } catch (err) {
          this.logger.warn(`Failed to get health for queue '${qName}': ${(err as Error).message}`);
          return {
            queue: qName,
            failed: 0,
            active: 0,
            waiting: 0,
            delayed: 0,
            completed: 0,
            paused: 0,
            totalProcessed: 0,
          };
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Converts a BullMQ Job into a rich FailedJobInspection with derived metadata.
   */
  private buildInspection(job: Job, queueName: string): FailedJobInspection {
    const processingDurationMs =
      job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn : undefined;

    // Determine derived status
    let status: FailedJobInspection['status'] = 'failed';
    const stacktrace = job.stacktrace ?? [];
    const allText = [job.failedReason, ...stacktrace].join('\n');
    if (/UnrecoverableError/i.test(allText)) {
      status = 'unrecoverable';
    } else if (job.attemptsMade >= 3) {
      status = 'exhausted';
    }

    return {
      id: String(job.id),
      name: job.name,
      queue: queueName,
      data: job.data,
      opts: (job.opts as Record<string, unknown>) ?? {},
      failedReason: job.failedReason,
      stacktrace,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      returnvalue: job.returnvalue,
      status,
      processingDurationMs,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      Array.from(this.queueHandles.values()).map((queue) =>
        queue.close().catch(() => undefined),
      ),
    );
  }
}
