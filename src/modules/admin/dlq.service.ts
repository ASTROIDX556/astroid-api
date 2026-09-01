import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  OnModuleDestroy,
} from '@nestjs/common';
import { Queue, Job } from 'bullmq';
import { redisConfig } from '../../config/redis.config';
import { Queues } from '../../queues/queues.constants';
import { PrismaService } from '../../database/prisma.service';
import { DomainEventName } from '../../events/event-names';
import {
  DlqJobDetails,
  ListDlqJobsQuery,
  PurgeDlqDto,
  QueueJobCounts,
} from './dto/dlq.dto';

@Injectable()
export class DlqService implements OnModuleDestroy {
  private readonly logger = new Logger(DlqService.name);
  private readonly queueHandles: Map<string, Queue> = new Map();
  private readonly knownQueueNames: Set<string> = new Set(Object.values(Queues));

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns all known queue names (both standard and dynamically accessed).
   */
  public getKnownQueueNames(): string[] {
    return Array.from(new Set([...this.knownQueueNames, ...this.queueHandles.keys()]));
  }

  /**
   * Retrieves or lazily creates a BullMQ Queue instance by name.
   */
  public getOrCreateQueue(queueName: string): Queue {
    this.knownQueueNames.add(queueName);
    let queue = this.queueHandles.get(queueName);
    if (!queue) {
      const { host, port, password, db } = redisConfig();
      queue = new Queue(queueName, {
        connection: {
          host,
          port,
          password: password || undefined,
          db,
        },
      });
      this.queueHandles.set(queueName, queue);
    }
    return queue;
  }

  /**
   * Lists failed jobs with pagination across one or all registered queues.
   */
  async listFailedJobs(query: ListDlqJobsQuery): Promise<{
    items: DlqJobDetails[];
    total: number;
    page: number;
    limit: number;
    queue?: string;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    if (query.queue) {
      const queue = this.getOrCreateQueue(query.queue);
      const start = query.start !== undefined ? query.start : (page - 1) * limit;
      const end = query.end !== undefined ? query.end : start + limit - 1;

      const [jobs, total] = await Promise.all([
        queue.getFailed(start, end),
        queue.getFailedCount(),
      ]);

      return {
        items: jobs.map((job) => this.formatJobDetails(job, query.queue!)),
        total,
        page,
        limit,
        queue: query.queue,
      };
    }

    // Query across all known queues
    const allQueueNames = this.getKnownQueueNames();
    const queueResults = await Promise.all(
      allQueueNames.map(async (qName) => {
        const queue = this.getOrCreateQueue(qName);
        try {
          const count = await queue.getFailedCount();
          return { qName, count, queue };
        } catch {
          return { qName, count: 0, queue };
        }
      }),
    );

    const total = queueResults.reduce((acc, curr) => acc + curr.count, 0);
    const start = query.start !== undefined ? query.start : (page - 1) * limit;
    const end = query.end !== undefined ? query.end : start + limit - 1;

    // Collect failed jobs from queues that have failures
    const collectedJobs: DlqJobDetails[] = [];
    for (const { qName, queue, count } of queueResults) {
      if (count > 0) {
        try {
          const jobs = await queue.getFailed(0, 100);
          for (const job of jobs) {
            collectedJobs.push(this.formatJobDetails(job, qName));
          }
        } catch (err) {
          this.logger.warn(`Failed to retrieve failed jobs from ${qName}: ${(err as Error).message}`);
        }
      }
    }

    // Sort by timestamp descending
    collectedJobs.sort((a, b) => (b.finishedOn ?? b.timestamp) - (a.finishedOn ?? a.timestamp));
    const paginatedItems = collectedJobs.slice(start, end + 1);

    return {
      items: paginatedItems,
      total,
      page,
      limit,
    };
  }

  /**
   * Retrieves full details and failure payload for a specific job.
   */
  async getJobDetails(queueName: string, jobId: string): Promise<DlqJobDetails> {
    const queue = this.getOrCreateQueue(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Job '${jobId}' not found in queue '${queueName}'`);
    }

    return this.formatJobDetails(job, queueName);
  }

  /**
   * Retries a specific failed job.
   */
  async retryJob(
    queueName: string,
    jobId: string,
  ): Promise<{ jobId: string; queue: string; retried: boolean; message: string }> {
    const queue = this.getOrCreateQueue(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Job '${jobId}' not found in queue '${queueName}'`);
    }

    const state = await job.getState();
    if (state !== 'failed') {
      throw new BadRequestException(
        `Job '${jobId}' in queue '${queueName}' is in '${state}' state and cannot be retried. Only 'failed' jobs can be retried.`,
      );
    }

    await job.retry();
    this.logger.log(`Job '${jobId}' in queue '${queueName}' retried by admin.`);

    await this.emitAuditEvent(DomainEventName.JobRequeued, {
      queue: queueName,
      jobId,
      jobName: job.name,
      retriedAt: new Date().toISOString(),
    });

    return {
      jobId,
      queue: queueName,
      retried: true,
      message: `Job '${jobId}' successfully moved from failed back to waiting queue.`,
    };
  }

  /**
   * Retries all failed jobs in a specific queue or across all queues.
   */
  async retryAllFailedJobs(
    queueName?: string,
  ): Promise<{ retriedCount: number; queues: string[] }> {
    const targetQueues = queueName ? [queueName] : this.getKnownQueueNames();
    let retriedCount = 0;
    const processedQueues: string[] = [];

    for (const qName of targetQueues) {
      try {
        const queue = this.getOrCreateQueue(qName);
        const failedJobs = await queue.getFailed();
        for (const job of failedJobs) {
          await job.retry();
          retriedCount++;
        }
        processedQueues.push(qName);
      } catch (err) {
        this.logger.warn(`Failed to retry jobs for queue ${qName}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Retried ${retriedCount} failed jobs across queues: ${processedQueues.join(', ')}`);

    if (retriedCount > 0) {
      await this.emitAuditEvent(DomainEventName.JobRequeued, {
        operation: 'batch_retry_all',
        retriedCount,
        queues: processedQueues,
        retriedAt: new Date().toISOString(),
      });
    }

    return {
      retriedCount,
      queues: processedQueues,
    };
  }

  /**
   * Removes / deletes a specific failed or dead-letter job.
   */
  async removeJob(
    queueName: string,
    jobId: string,
  ): Promise<{ jobId: string; queue: string; removed: boolean }> {
    const queue = this.getOrCreateQueue(queueName);
    const job = await queue.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Job '${jobId}' not found in queue '${queueName}'`);
    }

    await job.remove();
    this.logger.log(`Job '${jobId}' removed from queue '${queueName}'.`);

    return {
      jobId,
      queue: queueName,
      removed: true,
    };
  }

  /**
   * Purges failed jobs in a queue or across all queues.
   */
  async purgeQueue(
    dto: PurgeDlqDto,
  ): Promise<{ purgedCount: number; removedJobIds: string[]; queues: string[] }> {
    const targetQueues = dto.queue ? [dto.queue] : this.getKnownQueueNames();
    const gracePeriodMs = dto.gracePeriodMs ?? 0;
    const limit = dto.limit ?? 1000;

    let totalPurged = 0;
    const allRemovedIds: string[] = [];
    const processedQueues: string[] = [];

    for (const qName of targetQueues) {
      try {
        const queue = this.getOrCreateQueue(qName);
        const removedIds = await queue.clean(gracePeriodMs, limit, 'failed');
        totalPurged += removedIds.length;
        allRemovedIds.push(...removedIds);
        processedQueues.push(qName);
      } catch (err) {
        this.logger.warn(`Failed to purge queue ${qName}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Purged ${totalPurged} failed jobs from queues: ${processedQueues.join(', ')}`);

    return {
      purgedCount: totalPurged,
      removedJobIds: allRemovedIds,
      queues: processedQueues,
    };
  }

  /**
   * Returns job counts for all registered queues.
   */
  async getQueueStats(): Promise<QueueJobCounts[]> {
    const allQueueNames = this.getKnownQueueNames();

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

          return {
            queue: qName,
            failed: counts.failed ?? 0,
            active: counts.active ?? 0,
            waiting: counts.waiting ?? 0,
            delayed: counts.delayed ?? 0,
            completed: counts.completed ?? 0,
            paused: counts.paused ?? 0,
          };
        } catch (err) {
          this.logger.warn(`Failed to get job counts for queue ${qName}: ${(err as Error).message}`);
          return {
            queue: qName,
            failed: 0,
            active: 0,
            waiting: 0,
            delayed: 0,
            completed: 0,
            paused: 0,
          };
        }
      }),
    );
  }

  /**
   * Helper to format a BullMQ Job into a clean DlqJobDetails DTO.
   */
  private formatJobDetails(job: Job, queueName: string): DlqJobDetails {
    return {
      id: String(job.id),
      name: job.name,
      queue: queueName,
      data: job.data,
      opts: (job.opts as Record<string, unknown>) ?? {},
      failedReason: job.failedReason,
      stacktrace: job.stacktrace ?? [],
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      returnvalue: job.returnvalue,
    };
  }

  /**
   * Emits an audit event to the append-only domain_event ledger.
   * Best-effort — persistence failures are logged but never surface to the caller.
   */
  private async emitAuditEvent(
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.domainEvent.create({
        data: {
          name: eventName,
          aggregateType: 'ADMIN_DLQ',
          payload: payload as Record<string, never>,
          occurredAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to emit audit event '${eventName}': ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      Array.from(this.queueHandles.values()).map(async (queue) => {
        try {
          await queue.close();
        } catch (err) {
          this.logger.warn(`Error closing queue: ${(err as Error).message}`);
        }
      }),
    );
  }
}
