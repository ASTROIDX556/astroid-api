import type { JobsOptions } from 'bullmq';
import { buildJobOptions, createQueueRegistrationOptions } from './queue-policy';

/**
 * Default BullMQ job options tailored for Stellar Horizon and Soroban RPC
 * worker queues (5 attempts, 2000ms initial exponential backoff with jitter).
 */
export const STELLAR_RPC_JOB_OPTIONS: JobsOptions = buildJobOptions({
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
});

export function createStellarRpcQueueOptions(queueName: string) {
  return createQueueRegistrationOptions(queueName, STELLAR_RPC_JOB_OPTIONS);
}

/**
 * Computes exponential backoff delay when a Stellar RPC worker encounters
 * HTTP 429 or transient network timeouts.
 */
export function computeStellarRpcRetryDelayMs(
  attemptNumber: number,
  baseDelayMs = 2_000,
  maxDelayMs = 60_000,
): number {
  const safeAttempt = Math.max(1, Math.floor(attemptNumber));
  const raw = baseDelayMs * Math.pow(2, safeAttempt - 1);
  return Math.min(maxDelayMs, raw);
}
