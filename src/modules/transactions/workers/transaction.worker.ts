import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { Queues } from '../../../queues/queues.constants';
import { runWorkerJob, WorkerJobFailure } from '../../../workers/job-worker';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';

/** Result of an asynchronous execution, carried on the job payload. */
export interface TransactionJobResult {
  statusCode?: number;
  body?: unknown;
  requestId?: string;
}

/** Correlation identifiers recovered from a transaction job payload. */
interface TransactionJobContext {
  organizationId?: string;
  agentId?: string;
  transactionId?: string;
  result?: TransactionJobResult;
}

/**
 * Worker for the transaction execution queue.
 *
 * Failures are classified by the shared worker wrapper: transient errors are
 * rethrown so BullMQ reschedules them with exponential backoff and jitter,
 * while deterministic errors are marked unrecoverable and stop immediately.
 * When a job exhausts its retries the worker emits a `dead_letter.job_failed`
 * domain event, so the permanently failed transaction is visible in the event
 * ledger for manual review next to the dead-letter queue entry.
 */
@Processor(Queues.Transactions)
export class TransactionWorker extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(TransactionWorker.name);

  constructor(
    @Optional() private readonly eventBus?: EventBusService,
    @Optional() private readonly idempotency?: IdempotencyService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    await runWorkerJob({
      queue: Queues.Transactions,
      job,
      logger: this.logger,
      defaultJobName: 'transaction-execution',
      handler: () => this.execute(job),
      onFailure: (failure) => this.handleFailure(job, failure),
    });
  }

  /**
   * The unit of work executed for a transaction job. Extracted so the retry
   * and dead-letter behaviour can be exercised with a failing handler.
   */
  protected async execute(job: Job): Promise<void> {
    this.logger.debug(`Processing transaction job ${job.id}`);

    // An asynchronous execution carries its terminal result so the idempotency
    // record reserved by the API can be finalized with the response a replay
    // must return. Keyless executions simply have no record to update.
    const context = this.readJobContext(job);
    if (context.transactionId && context.result) {
      await this.idempotency?.finalizeTransaction(context.transactionId, {
        statusCode: context.result.statusCode ?? 200,
        body: (context.result.body ?? null) as Prisma.InputJsonValue,
        requestId: context.result.requestId,
      });
    }
  }

  /**
   * Warns the operator about a retryable failure and emits a domain event for
   * a permanently failed job.
   */
  private async handleFailure(job: Job, failure: WorkerJobFailure): Promise<void> {
    const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);

    if (!failure.terminal) {
      this.logger.warn(
        `Transaction job ${job.id} failed on attempt ${failure.attempt}/${failure.maxAttempts} and will be retried: ${reason}`,
      );
      return;
    }

    this.logger.error(
      `Transaction job ${job.id} failed permanently after ${failure.attempt}/${failure.maxAttempts} attempts and was routed to the dead-letter queue: ${reason}`,
    );

    const context = this.readJobContext(job);

    // A terminal failure frees the key: the record is marked FAILED, and the
    // next request that uses the key is processed as a fresh submission.
    if (context.transactionId) {
      await this.idempotency?.failTransaction(context.transactionId);
    }

    if (!this.eventBus) {
      return;
    }

    await this.eventBus.emit(
      DomainEventName.JobFailed,
      {
        queue: Queues.Transactions,
        jobId: job.id ?? null,
        jobName: job.name ?? 'transaction-execution',
        attemptsMade: failure.attempt,
        maxAttempts: failure.maxAttempts,
        reason,
        organizationId: context.organizationId,
        agentId: context.agentId,
        transactionId: context.transactionId,
      },
      {
        organizationId: context.organizationId,
        actorId: context.agentId,
        aggregateType: 'transaction',
        aggregateId: context.transactionId,
      },
    );
  }

  /** Recovers the correlation identifiers carried by the job payload. */
  private readJobContext(job: Job): TransactionJobContext {
    const data = (job.data ?? {}) as Record<string, unknown>;
    const metadata =
      data.metadata && typeof data.metadata === 'object'
        ? (data.metadata as Record<string, unknown>)
        : {};

    const read = (key: string): string | undefined => {
      const value = data[key] ?? metadata[key];
      return typeof value === 'string' ? value : undefined;
    };

    const result =
      data.result && typeof data.result === 'object'
        ? (data.result as TransactionJobResult)
        : undefined;

    return {
      organizationId: read('organizationId'),
      agentId: read('agentId'),
      transactionId: read('transactionId'),
      result,
    };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.worker) {
      this.worker.on('failed', (job, err) => {
        this.logger.error(`Job ${job?.id} failed: ${err.message}`);
      });
      this.worker.on('error', (err) => {
        this.logger.error(`Worker error: ${err.message}`);
      });
      this.worker.on('stalled', (jobId) => {
        this.logger.warn(`Job ${jobId} stalled`);
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.logger.log('TransactionWorker closed successfully');
    }
  }
}
