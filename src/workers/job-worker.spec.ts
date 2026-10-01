import { beforeEach, describe, expect, it, vi } from 'vitest';
<<<<<<< HEAD
import type { LoggerService } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { runWorkerJob, type WorkerJob } from './job-worker';

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
=======
import { UnrecoverableError } from 'bullmq';
import type { WorkerMetricsService } from '../modules/metrics/worker-metrics.service';
import { runWorkerJob, WorkerJob, WorkerJobLogRecord } from './job-worker';

const STELLAR_SEED = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4';

function buildLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function buildJob(overrides: Partial<WorkerJob<Record<string, unknown>>> = {}) {
  return {
    id: 'job-1',
    name: 'deliver',
    data: { webhookId: 'wh-1', secret: 'whsec_live', organizationId: 'org-1', traceId: 't-1' },
    attemptsMade: 0,
>>>>>>> origin/pr-370
    opts: { attempts: 3 },
    ...overrides,
  };
}

<<<<<<< HEAD
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

  it('includes trace fields from the job payload', async () => {
    const job = makeJob(
      { organizationId: 'org-1', traceId: 'trace-abc', extra: 'noise' },
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
    expect(record.trace).toEqual({ organizationId: 'org-1', traceId: 'trace-abc' });
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
=======
/** Parses the structured JSON record passed as the first argument of a log call. */
function record(mock: ReturnType<typeof vi.fn>, call = 0): WorkerJobLogRecord {
  return JSON.parse(String(mock.mock.calls[call][0])) as WorkerJobLogRecord;
}

describe('runWorkerJob', () => {
  let logger: ReturnType<typeof buildLogger>;

  beforeEach(() => {
    logger = buildLogger();
  });

  describe('successful execution', () => {
    it('returns the handler result and logs a completion record', async () => {
      const result = await runWorkerJob({
        queue: 'webhooks',
        job: buildJob(),
        logger,
        handler: async () => 'ok',
      });

      expect(result).toBe('ok');
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();

      const logged = record(logger.debug);
      expect(logged).toMatchObject({
        event: 'job.completed',
        queue: 'webhooks',
        jobId: 'job-1',
        jobName: 'deliver',
        attempt: 1,
        maxAttempts: 3,
      });
      expect(logged.durationMs).toBeGreaterThanOrEqual(0);
      expect(logged.payload).toBeUndefined();
    });

    it('falls back to logger.log when the logger has no debug level', async () => {
      const { debug: _debug, ...plain } = logger;
      await runWorkerJob({ queue: 'q', job: buildJob(), logger: plain, handler: async () => 1 });
      expect(record(plain.log).event).toBe('job.completed');
    });

    it('routes the handler through worker metrics when provided', async () => {
      const instrumentJob = vi.fn((_q: string, _n: string, fn: () => Promise<unknown>) => fn());
      const metrics = { instrumentJob } as unknown as Pick<WorkerMetricsService, 'instrumentJob'>;

      await runWorkerJob({
        queue: 'analytics',
        job: buildJob({ name: undefined }),
        logger,
        metrics,
        defaultJobName: 'analytics-rollup',
        handler: async () => undefined,
      });

      expect(instrumentJob).toHaveBeenCalledWith(
        'analytics',
        'analytics-rollup',
        expect.any(Function),
      );
    });

    it('defaults to the queue retry ceiling when the job carries no options', async () => {
      await runWorkerJob({
        queue: 'q',
        job: { data: {} },
        logger,
        handler: async () => undefined,
      });

      expect(record(logger.debug)).toMatchObject({ jobName: 'q', attempt: 1, maxAttempts: 3 });
    });
  });

  describe('transient failure', () => {
    it('logs a retrying warning and rethrows the original error', async () => {
      const boom = new Error('ECONNRESET');

      await expect(
        runWorkerJob({
          queue: 'webhooks',
          job: buildJob({ attemptsMade: 1 }),
          logger,
          handler: async () => {
            throw boom;
          },
        }),
      ).rejects.toBe(boom);

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const logged = record(logger.warn);
      expect(logged).toMatchObject({
        event: 'job.retrying',
        attempt: 2,
        maxAttempts: 3,
        error: { name: 'Error', message: 'ECONNRESET' },
        trace: { organizationId: 'org-1', traceId: 't-1' },
      });
      expect(String(logger.warn.mock.calls[0][1])).toContain('attempt 2/3; will retry');
    });

    it('retries again on a later attempt once it succeeds', async () => {
      const handler = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce('done');

      await expect(
        runWorkerJob({ queue: 'q', job: buildJob({ attemptsMade: 0 }), logger, handler }),
      ).rejects.toThrow('timeout');
      await expect(
        runWorkerJob({ queue: 'q', job: buildJob({ attemptsMade: 1 }), logger, handler }),
      ).resolves.toBe('done');

      expect(record(logger.warn).event).toBe('job.retrying');
      expect(record(logger.debug)).toMatchObject({ event: 'job.completed', attempt: 2 });
    });
  });

  describe('permanent failure', () => {
    it('logs a dead-letter record once the final attempt fails', async () => {
      await expect(
        runWorkerJob({
          queue: 'webhooks',
          job: buildJob({ attemptsMade: 2 }),
          logger,
          handler: async () => {
            throw new Error('HTTP 503');
          },
        }),
      ).rejects.toThrow('HTTP 503');

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const logged = record(logger.error);
      expect(logged).toMatchObject({
        event: 'job.dead-lettered',
        queue: 'webhooks',
        jobId: 'job-1',
        attempt: 3,
        maxAttempts: 3,
      });
      expect(logged.error?.stack).toContain('HTTP 503');
      expect(String(logger.error.mock.calls[0][1])).toContain('routing to dead-letter');
    });

    it('treats UnrecoverableError as terminal on the first attempt and rethrows it', async () => {
      const fatal = new UnrecoverableError('HTTP 422');

      await expect(
        runWorkerJob({
          queue: 'webhooks',
          job: buildJob({ attemptsMade: 0 }),
          logger,
          handler: async () => {
            throw fatal;
          },
        }),
      ).rejects.toBe(fatal);

      expect(record(logger.error)).toMatchObject({
        event: 'job.dead-lettered',
        attempt: 1,
        unrecoverable: true,
      });
    });

    it('describes non-Error throwables', async () => {
      await expect(
        runWorkerJob({
          queue: 'q',
          job: buildJob({ opts: { attempts: 1 } }),
          logger,
          handler: async () => {
            throw 'plain string';
          },
        }),
      ).rejects.toBe('plain string');

      expect(record(logger.error).error).toEqual({ name: 'NonError', message: 'plain string' });
    });
  });

  describe('sensitive data', () => {
    it('scrubs secrets from the logged payload, message and stack', async () => {
      await expect(
        runWorkerJob({
          queue: 'webhooks',
          job: buildJob({
            attemptsMade: 2,
            data: { webhookId: 'wh-1', secret: 'whsec_live', nested: { privateKey: 'pk' } },
          }),
          logger,
          handler: async () => {
            throw new Error(`signing failed with ${STELLAR_SEED}`);
          },
        }),
      ).rejects.toThrow(STELLAR_SEED);

      const line = String(logger.error.mock.calls[0][0]) + String(logger.error.mock.calls[0][1]);
      expect(line).not.toContain('whsec_live');
      expect(line).not.toContain(STELLAR_SEED);
      expect(record(logger.error).payload).toEqual({
        webhookId: 'wh-1',
        secret: '[REDACTED]',
        nested: { privateKey: '[REDACTED]' },
      });
    });
  });

  describe('logging resilience', () => {
    it('never lets a logger failure mask the job error', async () => {
      logger.warn.mockImplementation(() => {
        throw new Error('log sink down');
      });

      await expect(
        runWorkerJob({
          queue: 'q',
          job: buildJob(),
          logger,
          handler: async () => {
            throw new Error('real failure');
          },
        }),
      ).rejects.toThrow('real failure');
    });

    it('never fails a successful job because logging threw', async () => {
      logger.debug.mockImplementation(() => {
        throw new Error('log sink down');
      });

      await expect(
        runWorkerJob({ queue: 'q', job: buildJob(), logger, handler: async () => 7 }),
      ).resolves.toBe(7);
    });
>>>>>>> origin/pr-370
  });
});
