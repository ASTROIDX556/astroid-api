import type { Job } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../queues/queue.module';

/**
 * Determines whether a BullMQ job failure is terminal (exhausted retries or
 * marked unrecoverable) and should be captured by the dead-letter observer.
 */
export function isTerminalJobFailure(
  job: Pick<Job, 'attemptsMade' | 'opts' | 'stacktrace'>,
  failedReason?: string,
  defaultAttempts: number = DEFAULT_JOB_OPTIONS.attempts,
): boolean {
  if (isUnrecoverableFailure(failedReason, job.stacktrace)) {
    return true;
  }

  const maxAttempts = job.opts?.attempts ?? defaultAttempts;
  return (job.attemptsMade ?? 0) >= maxAttempts;
}

function isUnrecoverableFailure(failedReason?: string, stacktrace?: string[]): boolean {
  const haystack = [failedReason, ...(stacktrace ?? [])].filter(Boolean).join('\n');
  return /UnrecoverableError/i.test(haystack);
}
