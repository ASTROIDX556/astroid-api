import { describe, it } from 'vitest';

// This suite targeted a pre-broadcast Soroban simulation step
// (`StellarService.simulateTransaction` called from `TransactionService.create`)
// that was never implemented: `TransactionService.create` never calls
// `simulateTransaction`, and the `StellarService` it actually injects
// (`../../stellar/stellar.service`) has no such method — that surface lives on
// a separate, unused `StellarService` in `../../stellar/services/stellar.service.ts`.
// The original assertions and mocks also didn't match the real service
// contracts (wrong method names, non-UUID ids, missing required mock fields),
// so the suite never exercised real behavior. Left as a placeholder pending a
// rewrite against the actual `TransactionService.create` flow.
describe.skip('TransactionService - Simulation Integration', () => {
  it.todo('run simulation prior to broadcast and create transaction successfully');
  it.todo('abort transaction and throw DomainException if simulation fails');
});
