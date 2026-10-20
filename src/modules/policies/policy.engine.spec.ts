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

  describe('limit boundaries', () => {
    it('allows an amount that is exactly the maximum', () => {
      const result = engine.evaluate(baseIntent, [policy({ configuration: { maxAmount: 100 } })]);
      expect(result.passed).toBe(true);
    });

    it('rejects an amount that is one unit above the maximum', () => {
      const result = engine.evaluate(
        { ...baseIntent, amount: 100.01 },
        [policy({ configuration: { maxAmount: 100 } })],
      );
      expect(result.violations[0].code).toBe('MAX_AMOUNT_EXCEEDED');
    });

    it('allows an amount that is exactly the minimum', () => {
      const result = engine.evaluate(
        { ...baseIntent, amount: 100 },
        [policy({ configuration: { minAmount: 100 } })],
      );
      expect(result.passed).toBe(true);
    });

    it('rejects an amount that is one unit below the minimum', () => {
      const result = engine.evaluate(
        { ...baseIntent, amount: 99.99 },
        [policy({ configuration: { minAmount: 100 } })],
      );
      expect(result.violations[0].code).toBe('MIN_AMOUNT_NOT_MET');
    });

    it('allows a projected spend that is exactly the daily limit', () => {
      const result = engine.evaluate(
        { ...baseIntent, amount: 100, spentToday: 900 },
        [policy({ configuration: { dailyLimit: 1000 } })],
      );
      expect(result.passed).toBe(true);
    });

    it('allows a projected spend that is exactly the weekly limit', () => {
      const result = engine.evaluate(
        { ...baseIntent, amount: 100, spentThisWeek: 900 },
        [policy({ configuration: { weeklyLimit: 1000 } })],
      );
      expect(result.passed).toBe(true);
    });

    it('allows a projected spend that is exactly the monthly limit', () => {
      const result = engine.evaluate(
        { ...baseIntent, amount: 100, spentThisMonth: 900 },
        [policy({ configuration: { monthlyLimit: 1000 } })],
      );
      expect(result.passed).toBe(true);
    });

    it('allows a leg that is exactly at its own per-asset limit', () => {
      const result = engine.evaluate(
        {
          ...baseIntent,
          transfers: [
            { asset: 'XLM', amount: 100 },
            { asset: 'USDC', amount: 50 },
          ],
        },
        [policy({ configuration: { assetLimits: { USDC: { maxAmount: 50 } } } })],
      );
      expect(result.passed).toBe(true);
    });

    it('rejects the leg that exceeds its own per-asset limit', () => {
      const result = engine.evaluate(
        {
          ...baseIntent,
          transfers: [
            { asset: 'XLM', amount: 100 },
            { asset: 'USDC', amount: 50.01 },
          ],
        },
        [policy({ configuration: { assetLimits: { USDC: { maxAmount: 50 } } } })],
      );
      expect(result.violations[0].code).toBe('MAX_AMOUNT_EXCEEDED');
      expect(result.violations[0].asset).toBe('USDC');
    });
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

describe('PolicyEngine multi-asset evaluation (issue #444)', () => {
  const engine = new PolicyEngine();
  const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  const multiAssetIntent: TransactionIntent = {
    organizationId: 'org-1',
    agentId: 'agent-1',
    asset: 'XLM',
    amount: 10,
    recipientAddress: 'GABC',
    transfers: [
      { asset: 'XLM', amount: 10 },
      { asset: 'USDC', amount: 100 },
    ],
  };

  it('passes a valid multi-asset transfer', () => {
    const result = engine.evaluate(multiAssetIntent, [
      policy({ configuration: { maxAmount: 1000, dailyLimit: 5000 } }),
    ]);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('reports the offending asset in the violation', () => {
    const result = engine.evaluate(multiAssetIntent, [
      policy({ configuration: { maxAmount: 50 } }),
    ]);
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.code === 'MAX_AMOUNT_EXCEEDED');
    expect(violation?.asset).toBe('USDC');
    expect(violation?.message).toContain('100 USDC');
  });

  it('enforces per-asset limits instead of the policy-wide limit', () => {
    const result = engine.evaluate(multiAssetIntent, [
      policy({
        configuration: {
          maxAmount: 1000,
          assetLimits: { XLM: { maxAmount: 5 }, USDC: { maxAmount: 500 } },
        },
      }),
    ]);
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.code === 'MAX_AMOUNT_EXCEEDED');
    expect(violation?.asset).toBe('XLM');
  });

  it('applies the per-asset daily limit to the spend of that asset only', () => {
    const result = engine.evaluate(
      {
        ...multiAssetIntent,
        spentByAsset: {
          XLM: { spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 },
          USDC: { spentToday: 450, spentThisWeek: 450, spentThisMonth: 450 },
        },
      },
      [policy({ configuration: { assetLimits: { USDC: { dailyLimit: 500 } } } })],
    );
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.code === 'DAILY_LIMIT_EXCEEDED');
    expect(violation?.asset).toBe('USDC');
    expect(violation?.message).toContain('Projected daily spend 550 USDC exceeds limit 500 USDC');
  });

  it('does not report the same policy-level violation once per leg', () => {
    const result = engine.evaluate(multiAssetIntent, [
      policy({ configuration: { emergencyLock: true } }),
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].code).toBe('EMERGENCY_LOCK');
  });

  it('applies the asset allow list to every leg', () => {
    const result = engine.evaluate(multiAssetIntent, [
      policy({ configuration: { allowedAssets: ['XLM'] } }),
    ]);
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.code === 'ASSET_NOT_ALLOWED');
    expect(violation?.asset).toBe('USDC');
  });

  it('matches an issued asset against the ticker of its allow list', () => {
    const result = engine.evaluate(
      {
        ...multiAssetIntent,
        transfers: [{ asset: `USDC:${ISSUER}`, amount: 100 }],
      },
      [policy({ configuration: { allowedAssets: ['USDC'] } })],
    );
    expect(result.passed).toBe(true);
  });

  it('requires approval when a leg reaches the approval threshold', () => {
    const result = engine.evaluate(multiAssetIntent, [
      policy({ configuration: { requiresApproval: true, approvalThreshold: 50 } }),
    ]);
    expect(result.passed).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it('keeps single-asset intents behaving exactly as before', () => {
    const result = engine.evaluate(
      { ...baseIntent, amount: 100, spentToday: 950 },
      [policy({ configuration: { maxAmount: 1000, dailyLimit: 1000 } })],
    );
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(['DAILY_LIMIT_EXCEEDED']);
    expect(result.violations[0].asset).toBe('USDC');
  });
});
