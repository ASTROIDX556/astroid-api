import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';

import { TransactionWorker } from './transaction.worker';
import { Queues } from '../../../queues/queues.constants';
import { EventBusService } from '../../../events/event-bus.service';
import { DomainEventName } from '../../../events/event-names';
import { PermanentJobError } from '../../../queues/queue-policy';
import { IdempotencyService } from '../../../common/idempotency/idempotency.service';

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'transaction-execution',
    data: {
      organizationId: 'org-1',
      agentId: 'agent-1',
      transactionId: 'tx-1',
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as unknown as Job;
}

/** Worker whose execution step always throws the given error. */
function buildFailingWorker(
  eventBus: { emit: ReturnType<typeof vi.fn> },
  error: Error,
): TransactionWorker {
  const worker = new TransactionWorker(eventBus as unknown as EventBusService);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (worker as any).execute = vi.fn().mockRejectedValue(error);
  return worker;
}

describe('TransactionWorker', () => {
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let worker: TransactionWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    worker = new TransactionWorker(eventBus as unknown as EventBusService);
  });

  it('processes a transaction job without emitting a failure event', async () => {
    await worker.process(buildJob());

    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('finalizes the idempotency record when a job reports a terminal result', async () => {
    const idempotency = {
      finalizeTransaction: vi.fn().mockResolvedValue(1),
      failTransaction: vi.fn().mockResolvedValue(0),
    };
    const idempotentWorker = new TransactionWorker(
      eventBus as unknown as EventBusService,
      idempotency as unknown as IdempotencyService,
    );

    await idempotentWorker.process(
      buildJob({
        data: {
          organizationId: 'org-1',
          transactionId: 'tx-1',
          result: { statusCode: 201, body: { ok: true }, requestId: 'req-1' },
        },
      }),
    );

    expect(idempotency.finalizeTransaction).toHaveBeenCalledWith('tx-1', {
      statusCode: 201,
      body: { ok: true },
      requestId: 'req-1',
    });
    expect(idempotency.failTransaction).not.toHaveBeenCalled();
  });

  it('frees the idempotency key when a job fails terminally', async () => {
    const idempotency = {
      finalizeTransaction: vi.fn().mockResolvedValue(0),
      failTransaction: vi.fn().mockResolvedValue(1),
    };
    const failing = new TransactionWorker(
      eventBus as unknown as EventBusService,
      idempotency as unknown as IdempotencyService,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (failing as any).execute = vi.fn().mockRejectedValue(new UnrecoverableError('boom'));

    await expect(failing.process(buildJob({ attemptsMade: 0 }))).rejects.toThrow('boom');

    expect(idempotency.failTransaction).toHaveBeenCalledWith('tx-1');
  });

  it('rethrows a transient failure so BullMQ retries it with backoff', async () => {
    const failing = buildFailingWorker(eventBus, new Error('horizon timeout'));

    await expect(failing.process(buildJob({ attemptsMade: 0 }))).rejects.toThrow(
      'horizon timeout',
    );

    // The job is retried, so no dead-letter event is published yet.
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('emits a dead-letter domain event when the retries are exhausted', async () => {
    const failing = buildFailingWorker(eventBus, new Error('horizon timeout'));

    // The third attempt of a job configured for three attempts is the last one.
    await expect(failing.process(buildJob({ attemptsMade: 2 }))).rejects.toThrow(
      'horizon timeout',
    );

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    const [name, payload, options] = eventBus.emit.mock.calls[0];
    expect(name).toBe(DomainEventName.JobFailed);
    expect(payload).toEqual(
      expect.objectContaining({
        queue: Queues.Transactions,
        jobId: 'job-1',
        attemptsMade: 3,
        maxAttempts: 3,
        reason: 'horizon timeout',
        organizationId: 'org-1',
        agentId: 'agent-1',
        transactionId: 'tx-1',
      }),
    );
    expect(options).toEqual(
      expect.objectContaining({
        organizationId: 'org-1',
        aggregateType: 'transaction',
        aggregateId: 'tx-1',
      }),
    );
  });

  it('marks deterministic failures as unrecoverable so they are not retried', async () => {
    const failing = buildFailingWorker(
      eventBus,
      new PermanentJobError('malformed transaction payload'),
    );

    await expect(failing.process(buildJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('keeps working when the event bus is unavailable', async () => {
    const standalone = new TransactionWorker();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (standalone as any).execute = vi.fn().mockRejectedValue(new Error('horizon timeout'));

    await expect(standalone.process(buildJob({ attemptsMade: 2 }))).rejects.toThrow(
      'horizon timeout',
    );
  });
});
