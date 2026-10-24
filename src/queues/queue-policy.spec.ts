import { describe, expect, it, vi } from 'vitest';
import {
  buildJobOptions,
  createJitteredBackoffStrategy,
  createQueueRegistrationOptions,
  DEFAULT_JOB_OPTIONS,
  PermanentJobError,
  RetryableJobError,
  classifyJobError,
} from './queue-policy';

describe('shared queue policy', () => {
  it('provides bounded retries, exponential backoff, and bounded retention', () => {
    expect(DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { age: 24 * 3_600, count: 5_000 },
    });
  });

  it('inherits defaults while keeping explicit domain overrides typed', () => {
    expect(buildJobOptions({ attempts: 5, backoff: { type: 'exponential', delay: 2_000 } })).toEqual({
      ...DEFAULT_JOB_OPTIONS,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
    });
  });

  it('keeps failed-job count retention when a domain overrides only the age', () => {
    expect(buildJobOptions({ removeOnFail: { age: 12 * 3_600 } }).removeOnFail).toEqual({
      age: 12 * 3_600,
      count: 5_000,
    });
  });

  it('registers jittered backoff and retention for each queue', () => {
    const registration = createQueueRegistrationOptions('notifications');
    expect(registration.name).toBe('notifications');
    expect(registration.defaultJobOptions).toEqual(DEFAULT_JOB_OPTIONS);
    expect(
      (registration.settings as unknown as Record<string, unknown>).backoffStrategy,
    ).toBeTypeOf('function');
  });

  it('applies bounded jitter to retry delays', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // The strategy receives the 1-based attempt number BullMQ passes to it,
    // so the first retry waits the base delay — exactly like BullMQ's built-in
    // exponential backoff — plus the bounded jitter.
    expect(createJitteredBackoffStrategy(1_000)(1, 'exponential', new Error())).toBe(1_100);
    vi.restoreAllMocks();
  });

  it('caps the jittered retry delay at the configured maximum', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(createJitteredBackoffStrategy(1_000, 2_000)(10, 'exponential', new Error())).toBe(2_000);
    vi.restoreAllMocks();
  });

  it('classifies permanent and retryable failures through typed errors', () => {
    expect(classifyJobError(new PermanentJobError('invalid input'))).toBe('permanent');
    expect(classifyJobError(new RetryableJobError('temporary outage'))).toBe('retryable');
    expect(classifyJobError(new Error('temporary outage'))).toBe('retryable');
    expect(classifyJobError({ name: 'ValidationError' })).toBe('permanent');
    expect(classifyJobError({ getStatus: () => 401 })).toBe('permanent');
    expect(classifyJobError({ getStatus: () => 429 })).toBe('retryable');
    expect(classifyJobError({ statusCode: 503 })).toBe('retryable');
  });
});