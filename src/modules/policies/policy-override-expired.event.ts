// Emitted when an expired spending override is terminated by the cleanup job.
// Carries the policy id and the limit that was overridden (previousLimit = the
// temporary overrideLimit) alongside the restoredLimit that takes effect after
// the override is cleared.
export class PolicyOverrideExpiredEvent {
  constructor(
    public readonly policyId: string,
    public readonly previousLimit: number,
    public readonly restoredLimit: number,
    public readonly expiredAt: Date,
  ) {}
}
