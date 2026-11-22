import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { BadRequestException } from '@nestjs/common';
import { runWorkerJob, type WorkerJob } from './job-worker';
import { RequestContext } from '../common/context/request-context';
import { currentJobMetadata, NO_REQUEST_CONTEXT } from '../queues/job-correlation';

vi.mock('../queues/queue.module', () => ({
  DEFAULT_JOB_OPTIONS: { attempts: 3, backoff: { type: 'exponential', delay: 1_000 } },
}));

vi.mock('./dlq.processor', () => ({
  isTerminalJobFailure: vi.fn(
    (job: { attemptsMade: number; opts: { attempts: number } }) =>
      job.attemptsMade >= job.opts.attempts,
  ),
}));

vi.mock('../utils/log-scrubber.util', () => ({
  scrubForLog: vi.fn((v: unknown) => v),
  scrubString: vi.fn((s: string) => s),
}));

const STELLAR_SEED = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4';

function makeLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } satisfies Pick<LoggerService, 'log' | 'warn' | 'error' | 'debug'>;
}

function makeJob<T>(data: T, overrides: Partial<WorkerJob<T>> = {}): WorkerJob<T> {
  return {
    id: 'job-1',
    name: 'test-job',
    data,
    attemptsMade: 2,
    opts: { attempts: 3 },
    ...overrides,
  };
}

describe('runWorkerJob', () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
    vi.clearAllMocks();
  });

  it('calls the handler and returns its result', async () => {
    const result = await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({ amount: 100 }),
      logger,
      handler: async () => 'success',
    });

    expect(result).toBe('success');
  });

  it('calls metrics.instrumentJob when metrics are provided', async () => {
    const instrumentJob = vi.fn().mockResolvedValue('metered');
    const metrics = { instrumentJob } as unknown as Parameters<typeof runWorkerJob>[0]['metrics'];

    const result = await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({ amount: 100 }),
      logger,
      metrics,
      defaultJobName: 'my-job',
      handler: async () => 'metered',
    });

    expect(instrumentJob).toHaveBeenCalledWith('test-queue', 'test-job', expect.any(Function));
    expect(result).toBe('metered');
  });

  it('does not call metrics.instrumentJob when metrics are omitted', async () => {
    const handler = vi.fn().mockResolvedValue('direct');

    await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({ amount: 100 }),
      logger,
      handler,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('uses defaultJobName when job.name is absent', async () => {
    const instrumentJob = vi.fn().mockResolvedValue(undefined);

    await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({}, { name: undefined }),
      logger,
      metrics: { instrumentJob } as unknown as Parameters<typeof runWorkerJob>[0]['metrics'],
      defaultJobName: 'fallback-name',
      handler: async () => undefined,
    });

    expect(instrumentJob).toHaveBeenCalledWith('test-queue', 'fallback-name', expect.any(Function));
  });

  it('logs job.completed on success via debug when available', async () => {
    await runWorkerJob({
      queue: 'test-queue',
      job: makeJob({}),
      logger,
      handler: async () => undefined,
    });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(logger.debug.mock.calls[0][0]));
    expect(record).toMatchObject({ event: 'job.completed', queue: 'test-queue', jobId: 'job-1' });
  });

  it('rethrows errors from the handler unchanged', async () => {
    const boom = new Error('handler blew up');
    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job: makeJob({}),
        logger,
        handler: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });

  it('logs job.retrying when retries remain', async () => {
    const job = makeJob({ walletId: 'w-1' }, { attemptsMade: 0, opts: { attempts: 3 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error('transient failure');
        },
      }),
    ).rejects.toThrow('transient failure');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(logger.warn.mock.calls[0][0]));
    expect(record).toMatchObject({ event: 'job.retrying', attempt: 1, maxAttempts: 3 });
  });

  it('logs job.dead-lettered when retries are exhausted', async () => {
    const job = makeJob({ walletId: 'w-1' }, { attemptsMade: 2, opts: { attempts: 3 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error('final failure');
        },
      }),
    ).rejects.toThrow('final failure');

    expect(logger.error).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(record).toMatchObject({ event: 'job.dead-lettered', attempt: 3, maxAttempts: 3 });
  });

  it('treats UnrecoverableError as terminal on the first attempt', async () => {
    const job = makeJob({}, { attemptsMade: 0, opts: { attempts: 5 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new UnrecoverableError('invalid payload');
        },
      }),
    ).rejects.toThrow('invalid payload');

    expect(logger.error).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(record).toMatchObject({ event: 'job.dead-lettered', unrecoverable: true });
  });

  it('converts deterministic HTTP validation errors into unrecoverable BullMQ errors', async () => {
    const job = makeJob({}, { attemptsMade: 0, opts: { attempts: 5 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new BadRequestException('invalid payload');
        },
      }),
    ).rejects.toThrow(UnrecoverableError);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('includes trace fields from top-level and nested job metadata', async () => {
    const job = makeJob(
      {
        organizationId: 'org-1',
        metadata: { requestId: 'req-123', correlationId: 'corr-123' },
        traceId: 'trace-abc',
        extra: 'noise',
      },
      { attemptsMade: 2, opts: { attempts: 3 } },
    );

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow();

    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(record.trace).toEqual({
      organizationId: 'org-1',
      requestId: 'req-123',
      correlationId: 'corr-123',
      traceId: 'trace-abc',
    });
    expect(record.trace.extra).toBeUndefined();
  });

  it('never throws when the logging side effect itself fails', async () => {
    logger.error.mockImplementation(() => {
      throw new Error('log transport down');
    });

    const job = makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } });
    const boom = new Error('job error');

    // The original job error is still rethrown; the logging failure is swallowed.
    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });

  it('includes durationMs in every log record', async () => {
    const job = makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow();

    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(typeof record.durationMs).toBe('number');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  describe('request correlation', () => {
    const correlated = {
      organizationId: 'org-1',
      metadata: {
        requestId: 'req-123',
        correlationId: 'corr-123',
        traceId: 'trace-123',
        actorId: 'user-7',
        apiKeyId: 'key-9',
      },
    };

    it('adds the flat requestId, actorId and apiKeyId to a success record', async () => {
      await runWorkerJob({
        queue: 'test-queue',
        job: makeJob(correlated),
        logger,
        handler: async () => undefined,
      });

      const record = JSON.parse(String(logger.debug.mock.calls[0][0]));
      expect(record).toMatchObject({
        event: 'job.completed',
        requestId: 'req-123',
        actorId: 'user-7',
        apiKeyId: 'key-9',
      });
    });

    it.each([
      ['a retry', { attemptsMade: 0, opts: { attempts: 3 } }, 'warn'],
      ['a terminal failure', { attemptsMade: 2, opts: { attempts: 3 } }, 'error'],
    ] as const)('adds them to the record of %s', async (_label, overrides, level) => {
      await expect(
        runWorkerJob({
          queue: 'test-queue',
          job: makeJob(correlated, overrides),
          logger,
          handler: async () => {
            throw new Error('boom');
          },
        }),
      ).rejects.toThrow('boom');

      const record = JSON.parse(String(logger[level].mock.calls[0][0]));
      expect(record).toMatchObject({ requestId: 'req-123', actorId: 'user-7', apiKeyId: 'key-9' });
      expect(record.trace).toMatchObject({ requestId: 'req-123', actorId: 'user-7', apiKeyId: 'key-9' });
    });

    it('reads fields kept at the top level of an older payload', async () => {
      await runWorkerJob({
        queue: 'test-queue',
        job: makeJob({ requestId: 'req-old', actorId: 'user-old' }),
        logger,
        handler: async () => undefined,
      });

      const record = JSON.parse(String(logger.debug.mock.calls[0][0]));
      expect(record).toMatchObject({ requestId: 'req-old', actorId: 'user-old' });
    });

    it('logs a clearly marked fallback for a job enqueued without a request context', async () => {
      await runWorkerJob({
        queue: 'test-queue',
        job: makeJob({ transactionId: 'tx-1' }),
        logger,
        handler: async () => undefined,
      });

      const record = JSON.parse(String(logger.debug.mock.calls[0][0]));
      expect(record.requestId).toBe(NO_REQUEST_CONTEXT);
      expect(record).not.toHaveProperty('actorId');
      expect(record).not.toHaveProperty('apiKeyId');
    });

    it.each([null, undefined, 'a string', 42, [], { metadata: 'nope' }])(
      'tolerates a payload that carries no usable metadata: %j',
      async (data) => {
        await expect(
          runWorkerJob({
            queue: 'test-queue',
            job: makeJob(data),
            logger,
            handler: async () => 'ok',
          }),
        ).resolves.toBe('ok');

        const record = JSON.parse(String(logger.debug.mock.calls[0][0]));
        expect(record.requestId).toBe(NO_REQUEST_CONTEXT);
      },
    );

    it('ignores correlation values that are not non-empty strings', async () => {
      await runWorkerJob({
        queue: 'test-queue',
        job: makeJob({ metadata: { requestId: 123, actorId: '', apiKeyId: { id: 'x' } } }),
        logger,
        handler: async () => undefined,
      });

      const record = JSON.parse(String(logger.debug.mock.calls[0][0]));
      expect(record.requestId).toBe(NO_REQUEST_CONTEXT);
      expect(record).not.toHaveProperty('actorId');
      expect(record).not.toHaveProperty('apiKeyId');
    });

    it('runs the handler inside a request context rebuilt from the job', async () => {
      let seen: ReturnType<typeof currentJobMetadata> | undefined;
      let organizationId: string | undefined;

      await runWorkerJob({
        queue: 'test-queue',
        job: makeJob(correlated),
        logger,
        handler: async () => {
          seen = currentJobMetadata();
          organizationId = RequestContext.getOrganizationId();
          // A job enqueued from here would read these.
          await Promise.resolve();
          expect(RequestContext.getRequestId()).toBe('req-123');
        },
      });

      expect(seen).toEqual({
        requestId: 'req-123',
        correlationId: 'corr-123',
        traceId: 'trace-123',
        actorId: 'user-7',
        apiKeyId: 'key-9',
      });
      expect(organizationId).toBe('org-1');
      // The context does not leak out of the job.
      expect(RequestContext.getRequestId()).toBeUndefined();
    });

    it('does not invent a request context for a job that carries no request id', async () => {
      let requestId: string | undefined = 'unset';

      await runWorkerJob({
        queue: 'test-queue',
        job: makeJob({ transactionId: 'tx-1' }),
        logger,
        handler: async () => {
          requestId = RequestContext.getRequestId();
        },
      });

      expect(requestId).toBeUndefined();
    });

    it('does not change how a failing job is retried or rethrown', async () => {
      const boom = new Error('boom');

      await expect(
        runWorkerJob({
          queue: 'test-queue',
          job: makeJob(correlated, { attemptsMade: 0, opts: { attempts: 3 } }),
          logger,
          handler: async () => {
            throw boom;
          },
        }),
      ).rejects.toBe(boom);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  it('masks a Stellar seed in the error message before logging', async () => {
    const { scrubString } = await import('../utils/log-scrubber.util');
    (scrubString as ReturnType<typeof vi.fn>).mockImplementation((s: string) =>
      s.replace(STELLAR_SEED, '[REDACTED]'),
    );

    const job = makeJob({}, { attemptsMade: 2, opts: { attempts: 3 } });

    await expect(
      runWorkerJob({
        queue: 'test-queue',
        job,
        logger,
        handler: async () => {
          throw new Error(`rejected seed ${STELLAR_SEED}`);
        },
      }),
    ).rejects.toThrow();

    const record = JSON.parse(String(logger.error.mock.calls[0][0]));
    expect(record.error.message).not.toContain(STELLAR_SEED);
    expect(record.error.message).toContain('[REDACTED]');
  });
});
