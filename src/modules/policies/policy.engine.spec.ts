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

describe('PolicyEngine temporary overrides (issue #21)', () => {  const engine = new PolicyEngine();

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

describe('PolicyEngine velocity rules (issue #404)', () => {
  const engine = new PolicyEngine();

  it('allows a transaction while the velocity budget is not exhausted', () => {
    const result = engine.evaluate(
      { ...baseIntent, transactionCount: 2 },
      [policy({ configuration: { velocity: { maxTransactions: 5, window: 'hour' } } })],
    );
    expect(result.passed).toBe(true);
  });

  it('flags a transaction once the velocity limit is reached', () => {
    const result = engine.evaluate(
      { ...baseIntent, transactionCount: 5 },
      [policy({ configuration: { velocity: { maxTransactions: 5, window: 'hour' } } })],
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].code).toBe('VELOCITY_LIMIT_EXCEEDED');
  });

  it('prefers the per-window count when several velocity windows are declared', () => {
    const result = engine.evaluate(
      {
        ...baseIntent,
        transactionCount: 0,
        transactionCounts: { hour: 10, day: 1 },
      },
      [policy({ configuration: { velocity: { maxTransactions: 5, window: 'hour' } } })],
    );
    expect(result.violations[0].code).toBe('VELOCITY_LIMIT_EXCEEDED');
  });

  it('ignores the velocity rule when no count is available', () => {
    const result = engine.evaluate(
      baseIntent,
      [policy({ configuration: { velocity: { maxTransactions: 1, window: 'day' } } })],
    );
    expect(result.passed).toBe(true);
  });
});

describe('PolicyEngine multi-condition rule groups (issue #404)', () => {
  const engine = new PolicyEngine();

  it('passes when every condition of an AND group holds', () => {
    const result = engine.evaluate(baseIntent, [
      policy({
        configuration: {
          rules: [
            {
              logic: 'AND',
              conditions: [
                { field: 'amount', operator: 'lte', value: 500 },
                { field: 'asset', operator: 'eq', value: 'USDC' },
              ],
            },
          ],
        },
      }),
    ]);
    expect(result.passed).toBe(true);
  });

  it('flags a rule group when one of its conditions does not hold', () => {
    const result = engine.evaluate(baseIntent, [
      policy({
        configuration: {
          rules: [
            {
              id: 'spend-guard',
              logic: 'AND',
              conditions: [
                { field: 'amount', operator: 'lte', value: 50 },
                { field: 'asset', operator: 'eq', value: 'USDC' },
              ],
            },
          ],
        },
      }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.violations[0].code).toBe('RULE_GROUP_VIOLATED');
    expect(result.violations[0].message).toContain('spend-guard');
    expect(result.violations[0].message).toContain('amount');
  });

  it('passes an OR group when a single condition holds', () => {
    const result = engine.evaluate(baseIntent, [
      policy({
        configuration: {
          rules: [
            {
              logic: 'OR',
              conditions: [
                { field: 'asset', operator: 'eq', value: 'XLM' },
                { field: 'amount', operator: 'gte', value: 100 },
              ],
            },
          ],
        },
      }),
    ]);
    expect(result.passed).toBe(true);
  });

  it('flags an OR group when no condition holds', () => {
    const result = engine.evaluate(baseIntent, [
      policy({
        configuration: {
          rules: [
            {
              logic: 'OR',
              conditions: [
                { field: 'asset', operator: 'eq', value: 'XLM' },
                { field: 'amount', operator: 'gt', value: 1000 },
              ],
            },
          ],
        },
      }),
    ]);
    expect(result.violations[0].code).toBe('RULE_GROUP_VIOLATED');
  });

  it('evaluates recipient and agent conditions', () => {
    const result = engine.evaluate(
      { ...baseIntent, agentId: 'agent-1' },
      [
        policy({
          configuration: {
            rules: [
              {
                logic: 'AND',
                conditions: [
                  { field: 'recipientAddress', operator: 'eq', value: 'GABC' },
                  { field: 'agentId', operator: 'eq', value: 'agent-1' },
                ],
              },
            ],
          },
        }),
      ],
    );
    expect(result.passed).toBe(true);
  });

  it('supports the in and notIn operators', () => {
    const allowed = engine.evaluate(baseIntent, [
      policy({
        configuration: {
          rules: [
            {
              logic: 'AND',
              conditions: [{ field: 'asset', operator: 'in', value: ['USDC', 'XLM'] }],
            },
          ],
        },
      }),
    ]);
    expect(allowed.passed).toBe(true);

    const blocked = engine.evaluate(baseIntent, [
      policy({
        configuration: {
          rules: [
            {
              logic: 'AND',
              conditions: [{ field: 'asset', operator: 'notIn', value: ['USDC'] }],
            },
          ],
        },
      }),
    ]);
    expect(blocked.violations[0].code).toBe('RULE_GROUP_VIOLATED');
  });

  it('evaluates a condition against the transaction count', () => {
    const result = engine.evaluate(
      { ...baseIntent, transactionCount: 12 },
      [
        policy({
          configuration: {
            rules: [
              {
                logic: 'AND',
                conditions: [{ field: 'transactionCount', operator: 'lt', value: 10 }],
              },
            ],
          },
        }),
      ],
    );
    expect(result.violations[0].code).toBe('RULE_GROUP_VIOLATED');
  });
});

describe('PolicyEngine time windows with time zones (issue #404)', () => {
  const engine = new PolicyEngine();

  it('evaluates the window in the configured time zone', () => {
    // 20:00 UTC is 15:00 in New York (EST, UTC-5) and 20:00 in Lisbon (WET,
    // UTC+0 in January) — so the same instant is inside one window and
    // outside the other.
    const at = new Date(Date.UTC(2026, 0, 1, 20, 0, 0));

    const inside = engine.evaluate(
      { ...baseIntent, at },
      [
        policy({
          configuration: { timeWindow: { startHour: 8, endHour: 17, timezone: 'America/New_York' } },
        }),
      ],
    );
    expect(inside.passed).toBe(true);

    const outside = engine.evaluate(
      { ...baseIntent, at },
      [
        policy({
          configuration: { timeWindow: { startHour: 9, endHour: 17, timezone: 'Europe/Lisbon' } },
        }),
      ],
    );
    expect(outside.violations[0].code).toBe('OUTSIDE_TIME_WINDOW');
  });

  it('falls back to UTC for an unknown time zone', () => {
    const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    const result = engine.evaluate(
      { ...baseIntent, at },
      [
        policy({
          configuration: { timeWindow: { startHour: 9, endHour: 17, timezone: 'Not/AZone' } },
        }),
      ],
    );
    expect(result.passed).toBe(true);
  });

  it('applies the allowed weekdays in the configured time zone', () => {
    // 2026-01-01 is a Thursday (day 4).
    const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
    const result = engine.evaluate(
      { ...baseIntent, at },
      [
        policy({
          configuration: {
            timeWindow: { startHour: 9, endHour: 17, days: [1, 2, 3] },
          },
        }),
      ],
    );
    expect(result.violations[0].code).toBe('OUTSIDE_TIME_WINDOW');
  });
});
