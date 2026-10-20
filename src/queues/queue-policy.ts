import { UnrecoverableError, type BackoffStrategy, type JobsOptions } from 'bullmq';
import type { RegisterQueueOptions } from '@nestjs/bullmq';
import { jitteredBackoffDelay } from '../utils/backoff.util';

/** Shared bounded retry and retention defaults for background work. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { age: 24 * 3_600, count: 5_000 },
} as const satisfies JobsOptions;

/** Deterministic failures stop immediately; BullMQ treats this as unrecoverable. */
export class PermanentJobError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Explicit marker for failures that should consume the bounded retry policy. */
export class RetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

export type JobErrorClassification = 'permanent' | 'retryable';

export function classifyJobError(error: unknown): JobErrorClassification {
  if (error instanceof PermanentJobError || error instanceof UnrecoverableError) return 'permanent';
  if (error instanceof RetryableJobError) return 'retryable';
  if (!error || typeof error !== 'object') return 'retryable';

  const candidate = error as { getStatus?: () => number; status?: number; statusCode?: number; name?: string };
  let status = candidate.status ?? candidate.statusCode;
  if (status === undefined && typeof candidate.getStatus === 'function') {
    try {
      status = candidate.getStatus();
    } catch {
      return 'retryable';
    }
  }
  if (typeof status === 'number' && status >= 400 && status < 500 && ![408, 425, 429].includes(status)) {
    return 'permanent';
  }
  return ['ValidationError', 'ZodError'].includes(candidate.name ?? '') ? 'permanent' : 'retryable';
}

/** Build typed options while allowing deliberate domain-level overrides. */
export function buildJobOptions(overrides: JobsOptions = {}): JobsOptions {
  const backoff = overrides.backoff;
  return {
    ...DEFAULT_JOB_OPTIONS,
    ...overrides,
    ...(typeof backoff === 'object'
      ? { backoff: { ...DEFAULT_JOB_OPTIONS.backoff, ...backoff } }
      : backoff !== undefined
        ? { backoff }
        : {}),
    ...(typeof overrides.removeOnComplete === 'object'
      ? { removeOnComplete: { ...DEFAULT_JOB_OPTIONS.removeOnComplete, ...overrides.removeOnComplete } }
      : {}),
    ...(typeof overrides.removeOnFail === 'object'
      ? { removeOnFail: { ...DEFAULT_JOB_OPTIONS.removeOnFail, ...overrides.removeOnFail } }
      : {}),
  };
}

/**
 * Builds a jittered backoff strategy.
 *
 * The strategy receives the 1-based attempt number BullMQ passes to a custom
 * backoff strategy, so the first retry waits exactly the base delay — the same
 * schedule BullMQ's built-in exponential backoff produces, plus the jitter and
 * the optional maximum delay.
 *
 * The strategy is only used when the job options select the `custom` backoff
 * type: BullMQ prefers its built-in `fixed` and `exponential` strategies over
 * a registered custom strategy.
 */
export function createJitteredBackoffStrategy(
  baseDelayMs = 1_000,
  maxDelayMs?: number,
): BackoffStrategy {
  return (attemptsMade) => jitteredBackoffDelay(attemptsMade, baseDelayMs, maxDelayMs);
}

/**
 * Builds the registration options of a queue.
 *
 * `maxDelayMs` caps the delay the jittered backoff strategy produces. It is
 * passed separately because BullMQ's `BackoffOptions` only carries the base
 * delay — the effective delay of the platform is always computed by the
 * custom strategy, which is where the cap is applied.
 */
export function createQueueRegistrationOptions(
  name: string,
  overrides: JobsOptions = {},
  maxDelayMs?: number,
): RegisterQueueOptions {
  const defaultJobOptions = buildJobOptions(overrides);
  const configuredBackoff = defaultJobOptions.backoff;
  const baseDelay =
    configuredBackoff && typeof configuredBackoff === 'object' && 'delay' in configuredBackoff
      ? configuredBackoff.delay
      : 1_000;
  return {
    name,
    defaultJobOptions,
    settings: {
      backoffStrategy: createJitteredBackoffStrategy(baseDelay, maxDelayMs),
    } as RegisterQueueOptions['settings'],
  };
}