import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queues } from '../../queues/queues.constants';
import { buildJobOptions } from '../../queues/queue-policy';
import { AuditConfig } from '../../config/audit.config';

/** Job name used for the enqueued archival jobs. */
export const AUDIT_ARCHIVE_JOB_NAME = 'audit-archive';

/** Length of the window the job id is derived from (one hour). */
const JOB_ID_WINDOW_MS = 3_600_000;

/**
 * Schedules the audit archival job.
 *
 * The tick only *enqueues* the work: the archival itself runs in the BullMQ
 * worker, where it benefits from the shared retry and backoff policy and from
 * the structured worker logging. The job id is derived from the hour the tick
 * belongs to, so a duplicated tick — or a restart within the same hour —
 * never queues the same archival twice.
 */
@Injectable()
export class AuditArchiveScheduler {
  private readonly logger = new Logger(AuditArchiveScheduler.name);

  constructor(
    @InjectQueue(Queues.AuditArchive) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  /** The resolved archival configuration. */
  private get settings(): AuditConfig {
    return (
      this.config.get<AuditConfig>('audit') ?? {
        archiveEnabled: true,
        archiveRetentionDays: 30,
        archiveBatchSize: 500,
        archiveMaxBatches: 20,
        retentionDays: 90,
      }
    );
  }

  /** Enqueues the archival job once per hour. */
  @Cron(CronExpression.EVERY_HOUR)
  async enqueueArchiveJob(): Promise<void> {
    await this.enqueueAt(new Date());
  }

  /**
   * Enqueues one archival job. Failures are logged but never propagate into
   * the scheduler: a transient Redis outage must not crash the application.
   */
  async enqueueAt(now: Date): Promise<void> {
    if (!this.settings.archiveEnabled) {
      this.logger.debug('Audit archival is disabled; no job was enqueued');
      return;
    }

    const jobId = `${AUDIT_ARCHIVE_JOB_NAME}-${Math.floor(now.getTime() / JOB_ID_WINDOW_MS)}`;
    try {
      await this.queue.add(
        AUDIT_ARCHIVE_JOB_NAME,
        { requestedAt: now.toISOString() },
        { ...buildJobOptions(), jobId },
      );
      this.logger.debug(`Enqueued audit archival job ${jobId}`);
    } catch (error) {
      this.logger.error(
        `Failed to enqueue the audit archival job ${jobId}: ${(error as Error).message}`,
      );
    }
  }
}
