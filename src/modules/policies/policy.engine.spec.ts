import { describe, expect, it } from 'vitest';
import { PolicyEngine } from './policy.engine';
import { EvaluablePolicy, TransactionIntent } from './policy.types';

const baseIntent: TransactionIntent = {
  organizationId: 'org-1',
  agentId: 'agent-1',
  asset: 'USDC',
  amount: 100,
  recipientAddress: 'GABC',
};

function policy(overrides: Partial<EvaluablePolicy>): EvaluablePolicy {
  return {
    id: 'p1',
    name: 'Test Policy',
    priority: 100,
    enabled: true,
    agentId: null,
    configuration: {},
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  const engine = new PolicyEngine();

  it('passes when no policies apply', () => {
    const result = engine.evaluate(baseIntent, []);
    expect(result.passed).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.violations).toHaveLength(0);
  });

  it('flags a max amount violation', () => {
    const result = engine.evaluate(baseIntent, [policy({ configuration: { maxAmount: 50 } })]);
    expect(result.passed).toBe(false);
    expect(result.violations[0].code).toBe('MAX_AMOUNT_EXCEEDED');
  });

  it('flags a min amount violation', () => {
    const result = engine.evaluate(baseIntent, [policy({ configuration: { minAmount: 500 } })]);
    expect(result.violations[0].code).toBe('MIN_AMOUNT_NOT_MET');
  });

  it('enforces an asset allow list', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ configuration: { allowedAssets: ['XLM'] } }),
    ]);
    expect(result.violations[0].code).toBe('ASSET_NOT_ALLOWED');
  });

  it('enforces a blocked asset', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ configuration: { blockedAssets: ['USDC'] } }),
    ]);
    expect(result.violations[0].code).toBe('ASSET_BLOCKED');
  });

  it('enforces a recipient allow list', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ configuration: { allowedRecipients: ['GXYZ'] } }),
    ]);
    expect(result.violations[0].code).toBe('RECIPIENT_NOT_ALLOWED');
  });

  it('enforces a blocked recipient', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ configuration: { blockedRecipients: ['GABC'] } }),
    ]);
    expect(result.violations[0].code).toBe('RECIPIENT_BLOCKED');
  });

  it('enforces a daily limit including prior spend', () => {
    const result = engine.evaluate(
      { ...baseIntent, spentToday: 950 },
      [policy({ configuration: { dailyLimit: 1000 } })],
    );
    expect(result.violations[0].code).toBe('DAILY_LIMIT_EXCEEDED');
  });

  it('allows spend within the daily limit', () => {
    const result = engine.evaluate(
      { ...baseIntent, spentToday: 800 },
      [policy({ configuration: { dailyLimit: 1000 } })],
    );
    expect(result.passed).toBe(true);
  });

  it('requires approval when configured', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ configuration: { requiresApproval: true } }),
    ]);
    expect(result.passed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it('requires approval above an approval threshold', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ configuration: { approvalThreshold: 100 } }),
    ]);
    expect(result.requiresApproval).toBe(true);
  });

  it('blocks all spend under an emergency lock', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ configuration: { emergencyLock: true } }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.violations[0].code).toBe('EMERGENCY_LOCK');
  });

  it('enforces a UTC time window', () => {
    const at = new Date(Date.UTC(2026, 0, 1, 3, 0, 0)); // 03:00 UTC
    const result = engine.evaluate(
      { ...baseIntent, at },
      [policy({ configuration: { timeWindow: { startHour: 9, endHour: 17 } } })],
    );
    expect(result.violations[0].code).toBe('OUTSIDE_TIME_WINDOW');
  });

  it('passes within the time window', () => {
    const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    const result = engine.evaluate(
      { ...baseIntent, at },
      [policy({ configuration: { timeWindow: { startHour: 9, endHour: 17 } } })],
    );
    expect(result.passed).toBe(true);
  });

  it('ignores disabled policies', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ enabled: false, configuration: { maxAmount: 1 } }),
    ]);
    expect(result.passed).toBe(true);
  });

  it('ignores policies scoped to a different agent', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ agentId: 'other-agent', configuration: { maxAmount: 1 } }),
    ]);
    expect(result.passed).toBe(true);
  });

  it('accumulates violations across multiple policies', () => {
    const result = engine.evaluate(baseIntent, [
      policy({ id: 'a', configuration: { maxAmount: 50 } }),
      policy({ id: 'b', configuration: { blockedAssets: ['USDC'] } }),
    ]);
    expect(result.violations).toHaveLength(2);
    expect(result.evaluatedPolicyIds).toEqual(['a', 'b']);
  });
});

describe('PolicyEngine temporary overrides (issue #21)', () => {
  const engine = new PolicyEngine();

  it('enforces the override limit while an override is active', () => {
    const at = new Date('2026-08-01T12:00:00Z');
    const p = policy({
      id: 'p-override',
      configuration: { maxAmount: 100 },
      overrideLimit: 1000,
      overrideUntil: new Date('2026-08-02T00:00:00Z'),
      originalLimit: 100,
    });
    // A 500 amount is above the base 100 but below the 1000 override, so it passes.
    expect(engine.evaluate({ ...baseIntent, amount: 500, at }, [p]).passed).toBe(true);
    // A 2000 amount exceeds the override limit, so it fails.
    expect(engine.evaluate({ ...baseIntent, amount: 2000, at }, [p]).passed).toBe(false);
  });

  it('falls back to the base amount once the override has expired', () => {
    const at = new Date('2026-08-03T00:00:00Z');
    const p = policy({
      id: 'p-expired',
      configuration: { maxAmount: 100 },
      overrideLimit: 1000,
      overrideUntil: new Date('2026-08-02T00:00:00Z'),
      originalLimit: 100,
    });
    expect(engine.evaluate({ ...baseIntent, amount: 500, at }, [p]).passed).toBe(false);
  });

  it('restores the originalLimit after the override clears', () => {
    const at = new Date('2026-08-03T00:00:00Z');
    // Likely state after the cleanup job has run: columns cleared, config intact.
    const p = policy({
      id: 'p-cleared',
      configuration: { maxAmount: 100 },
      overrideLimit: null,
      overrideUntil: null,
      originalLimit: 100,
    });
    expect(engine.evaluate({ ...baseIntent, amount: 50, at }, [p]).passed).toBe(true);
    expect(engine.evaluate({ ...baseIntent, amount: 200, at }, [p]).passed).toBe(false);
  });
});
