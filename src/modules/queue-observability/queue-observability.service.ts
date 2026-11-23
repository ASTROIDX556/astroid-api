import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Queues, QueueName } from '../../queues/queues.constants';
import { QueueObservabilityConfig } from '../../config/queue-observability.config';
import { redisConfig } from '../../config/redis.config';

export interface QueueFailedJobDto {
  id: string;
  name: string;
  failedReason: string;
  attemptsMade: number;
  processedOn: number;
}

export interface QueueObservabilityDto {
  queueName: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    completed: number;
    failed: number;
  };
  oldestWaitingJobAgeMs: number | null;
  failedJobs: QueueFailedJobDto[];
}

export interface QueueObservabilityResponse {
  queues: QueueObservabilityDto[];
  timestamp: string;
}

/** Minimal queue interface for observability - avoids BullMQ Queue circular deps. */
interface QueueHandle {
  getJobCounts(...types: Array<'waiting' | 'active' | 'delayed' | 'completed' | 'failed'>): Promise<Record<string, number>>;
  getJobs(types?: 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | Array<'waiting' | 'active' | 'delayed' | 'completed' | 'failed'>, start?: number, end?: number, asc?: boolean): Promise<Array<{ timestamp?: number }>>;
  getFailed(start: number, end: number): Promise<Array<{ id: string | number; name: string; failedReason?: string; attemptsMade?: number; processedOn?: number }>>;
  close(): Promise<void>;
}

@Injectable()
export class QueueObservabilityService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueObservabilityService.name);
  private readonly queueHandles = new Map<string, QueueHandle>();

  constructor(private readonly configService: ConfigService) {}

  private get config(): QueueObservabilityConfig {
    return this.configService.get<QueueObservabilityConfig>('queueObservability')!;
  }

  private getQueueHandle(queueName: QueueName): QueueHandle {
    const existing = this.queueHandles.get(queueName);
    if (existing) {
      return existing;
    }
    const { host, port, password, db } = redisConfig();
    const queue = new Queue(queueName, {
      connection: { host, port, password: password || undefined, db },
    });
    this.queueHandles.set(queueName, queue);
    return queue;
  }

  private getRegisteredQueueNames(): QueueName[] {
    return Object.values(Queues);
  }

  async getObservability(): Promise<QueueObservabilityResponse> {
    const queueNames = this.getRegisteredQueueNames();
    const maxFailedJobs = Math.min(this.config.maxFailedJobsPerQueue, 20);

    const queueResults = await Promise.all(
      queueNames.map(async (queueName) => {
        const queue = this.getQueueHandle(queueName);
        try {
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'delayed',
            'completed',
            'failed',
          );

          let oldestWaitingJobAgeMs: number | null = null;
          if ((counts.waiting ?? 0) > 0) {
            const waitingJobs = await queue.getJobs(['waiting'], 0, 0, true);
            if (waitingJobs.length > 0) {
              const oldestJob = waitingJobs[0];
              const timestamp = oldestJob.timestamp ?? Date.now();
              oldestWaitingJobAgeMs = Date.now() - timestamp;
            }
          }

          const failedJobs: QueueFailedJobDto[] = [];
          if ((counts.failed ?? 0) > 0 && maxFailedJobs > 0) {
            const failedJobList = await queue.getFailed(0, maxFailedJobs - 1);
            for (const job of failedJobList) {
              failedJobs.push({
                id: String(job.id),
                name: job.name,
                failedReason: job.failedReason ?? 'unknown',
                attemptsMade: job.attemptsMade ?? 0,
                processedOn: job.processedOn ?? 0,
              });
            }
          }

          return {
            queueName: queueName,
            counts: {
              waiting: counts.waiting ?? 0,
              active: counts.active ?? 0,
              delayed: counts.delayed ?? 0,
              completed: counts.completed ?? 0,
              failed: counts.failed ?? 0,
            },
            oldestWaitingJobAgeMs,
            failedJobs,
          };
        } catch (error) {
          this.logger.error(
            `Failed to get observability for queue '${queueName}': ${(error as Error).message}`,
          );
          throw error;
        }
      }),
    );

    return {
      queues: queueResults,
      timestamp: new Date().toISOString(),
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