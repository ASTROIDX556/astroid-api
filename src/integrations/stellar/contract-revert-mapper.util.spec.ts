import { describe, expect, it } from 'vitest';
import { mapContractRevertReason } from './contract-revert-mapper.util';

describe('mapContractRevertReason (#304)', () => {
  it('maps known contract revert reasons to structured domain error codes', () => {
    const insufficient = mapContractRevertReason(
      new Error('HostError: Error(Contract, #101): insufficient_balance'),
    );
    expect(insufficient.code).toBe('CONTRACT_INSUFFICIENT_BALANCE');
    expect(insufficient.retryable).toBe(false);

    const resource = mapContractRevertReason('Soroban resource_limit exceeded');
    expect(resource.code).toBe('CONTRACT_RESOURCE_LIMIT');
    expect(resource.retryable).toBe(true);
  });

  it('falls back to CONTRACT_EXECUTION_REVERTED for unknown revert strings', () => {
    const unknown = mapContractRevertReason('Custom panic 0x99');
    expect(unknown.code).toBe('CONTRACT_EXECUTION_REVERTED');
    expect(unknown.rawReason).toBe('Custom panic 0x99');
  });
});
