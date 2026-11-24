import { describe, it, expect } from 'vitest';
import {
  STELLAR_RPC_JOB_OPTIONS,
  createStellarRpcQueueOptions,
  computeStellarRpcRetryDelayMs,
} from './stellar-rpc-backoff.policy';

describe('Stellar RPC Worker Backoff Policy (#419)', () => {
  it('configures 5 attempts and a 2000ms exponential backoff base delay', () => {
    expect(STELLAR_RPC_JOB_OPTIONS.attempts).toBe(5);
    expect(STELLAR_RPC_JOB_OPTIONS.backoff).toEqual({
      type: 'exponential',
      delay: 2_000,
    });
  });

  it('builds BullMQ queue registration options with custom settings', () => {
    const reg = createStellarRpcQueueOptions('stellar-rpc-submission');
    expect(reg.name).toBe('stellar-rpc-submission');
    expect(reg.defaultJobOptions?.attempts).toBe(5);
    expect(reg.settings).toBeDefined();
  });

  it('doubles retry delay exponentially up to maxDelayMs', () => {
    expect(computeStellarRpcRetryDelayMs(1, 2_000, 60_000)).toBe(2_000);
    expect(computeStellarRpcRetryDelayMs(2, 2_000, 60_000)).toBe(4_000);
    expect(computeStellarRpcRetryDelayMs(3, 2_000, 60_000)).toBe(8_000);
    expect(computeStellarRpcRetryDelayMs(10, 2_000, 60_000)).toBe(60_000);
  });
});
