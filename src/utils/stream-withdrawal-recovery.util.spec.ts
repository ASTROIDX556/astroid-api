import { describe, expect, it } from 'vitest';
import { classifyStreamWithdrawalError } from './stream-withdrawal-recovery.util';

describe('classifyStreamWithdrawalError (#275)', () => {
  it('classifies transient RPC failures as retryable and depleted balances as terminal', () => {
    expect(classifyStreamWithdrawalError('RPC_TIMEOUT')).toEqual({
      retryable: true,
      status: 503,
    });
    expect(classifyStreamWithdrawalError('INSUFFICIENT_STREAM_BALANCE')).toEqual({
      retryable: false,
      status: 400,
    });
  });
});
