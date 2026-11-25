import { describe, it, expect } from 'vitest';
import { PolicyType } from '@prisma/client';
import { createPolicySchema, updatePolicySchema } from './policy.dto';
import { policyConfigurationSchemaStrict } from './policy.types';

/**
 * Strict Zod validation for Agent Spending Policy Rules.
 *
 * Covers valid rule structures plus the malformed / overly-permissive edge
 * cases that could otherwise bypass security constraints (unknown properties,
 * asset whitelist conflicts, invalid threshold relationships, malformed
 * nested condition expressions, non-positive limits).
 */

describe('policyConfigurationSchemaStrict (agent spending rule validation)', () => {
  describe('valid configurations', () => {
    it('accepts an empty configuration (no constraints)', () => {
      const result = policyConfigurationSchemaStrict.parse({});
      expect(result).toEqual({});
    });

    it('accepts a full configuration with all supported fields', () => {
      const config = {
        maxAmount: 5000,
        minAmount: 10,
        allowedAssets: ['USDC', 'XLM'],
        blockedAssets: ['GOLD'],
        allowedRecipients: ['GA1', 'GA2'],
        blockedRecipients: ['GBAD'],
        dailyLimit: 300,
        weeklyLimit: 1500,
        monthlyLimit: 6000,
        timeWindow: { startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] },
        requiresApproval: true,
        approvalThreshold: 1000,
        emergencyLock: false,
      };
      const result = policyConfigurationSchemaStrict.parse(config);
      expect(result).toEqual(config);
    });

    it('accepts a partial minimal configuration', () => {
      const result = policyConfigurationSchemaStrict.parse({ maxAmount: 100 });
      expect(result).toEqual({ maxAmount: 100 });
    });

    it('accepts maxAmount equal to strict upper bound of minAmount (max > min)', () => {
      const result = policyConfigurationSchemaStrict.parse({ maxAmount: 200, minAmount: 199.99 });
      expect(result.maxAmount).toBe(200);
    });

    it('accepts disjoint allowed/blocked asset lists', () => {
      const result = policyConfigurationSchemaStrict.parse({
        allowedAssets: ['USDC'],
        blockedAssets: ['XLM'],
      });
      expect(result.allowedAssets).toEqual(['USDC']);
    });

    it('accepts approvalThreshold of zero without requiresApproval', () => {
      const result = policyConfigurationSchemaStrict.parse({ approvalThreshold: 0 });
      expect(result.approvalThreshold).toBe(0);
    });

    it('accepts timeWindow without days', () => {
      const result = policyConfigurationSchemaStrict.parse({
        timeWindow: { startHour: 0, endHour: 24 },
      });
      expect(result.timeWindow?.days).toBeUndefined();
    });
  });

  describe('strict mode (rejects unexpected properties)', () => {
    it('rejects unknown top-level properties', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ maxAmount: 100, rogue: true })).toThrow();
    });

    it('rejects unknown nested properties inside timeWindow', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({
          timeWindow: { startHour: 9, endHour: 17, unexpected: 1 },
        }),
      ).toThrow();
    });

    it('rejects a non-object body in a strict-typed field position', () => {
      expect(() => policyConfigurationSchemaStrict.parse([])).toThrow();
      expect(() => policyConfigurationSchemaStrict.parse('not-an-object')).toThrow();
      expect(() => policyConfigurationSchemaStrict.parse(null)).toThrow();
    });
  });

  describe('amount invariants', () => {
    it('rejects negative maxAmount', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ maxAmount: -1 })).toThrow();
    });

    it('rejects negative minAmount', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ minAmount: -5 })).toThrow();
    });

    it('rejects maxAmount not greater than minAmount', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ maxAmount: 100, minAmount: 100 })).toThrow(
        'maxAmount must be greater than minAmount',
      );
    });

    it('rejects maxAmount below minAmount', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ minAmount: 100, maxAmount: 50 })).toThrow();
    });

    it('rejects non-numeric amounts', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ maxAmount: 'abc' })).toThrow();
      expect(() => policyConfigurationSchemaStrict.parse({ maxAmount: null })).toThrow();
    });
  });

  describe('asset whitelist validation', () => {
    it('rejects an asset longer than the Stellar 12-char limit', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({ allowedAssets: ['THIS-IS-TOO-LONG'] }),
      ).toThrow();
    });

    it('rejects an empty asset string', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ allowedAssets: [''] })).toThrow();
    });

    it('rejects an asset present in both allowed and blocked lists', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({
          allowedAssets: ['USDC'],
          blockedAssets: ['USDC'],
        }),
      ).toThrow('Asset cannot be both in allowedAssets and blockedAssets');
    });

    it('rejects a recipient present in both allowed and blocked lists', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({
          allowedRecipients: ['GA1'],
          blockedRecipients: ['GA1'],
        }),
      ).toThrow('Recipient cannot be both in allowedRecipients and blockedRecipients');
    });

    it('rejects an empty recipient string', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({ allowedRecipients: [''] }),
      ).toThrow();
    });
  });

  describe('periodic limit validation', () => {
    it('rejects zero dailyLimit (periodic limits must be positive)', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ dailyLimit: 0 })).toThrow();
    });

    it('rejects negative weekly and monthly limits', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ weeklyLimit: -10 })).toThrow();
      expect(() => policyConfigurationSchemaStrict.parse({ monthlyLimit: -10 })).toThrow();
    });

    it('accepts positive daily limit', () => {
      const result = policyConfigurationSchemaStrict.parse({ dailyLimit: 1000 });
      expect(result.dailyLimit).toBe(1000);
    });
  });

  describe('approval invariants', () => {
    it('rejects a positive approvalThreshold without requiresApproval', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({ approvalThreshold: 500 }),
      ).toThrow('approvalThreshold requires requiresApproval to be true');
    });

    it('accepts requiresApproval without approvalThreshold', () => {
      const result = policyConfigurationSchemaStrict.parse({ requiresApproval: true });
      expect(result.requiresApproval).toBe(true);
    });

    it('rejects a negative approval threshold', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ approvalThreshold: -1 })).toThrow();
    });
  });

  describe('nested timeWindow condition expressions', () => {
    it('rejects startHour greater than or equal to endHour', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({ timeWindow: { startHour: 17, endHour: 17 } }),
      ).toThrow('startHour must be less than');
    });

    it('rejects startHour equal to endHour', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({ timeWindow: { startHour: 12, endHour: 12 } }),
      ).toThrow();
    });

    it('rejects startHour outside the 0-23 range', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({ timeWindow: { startHour: 24, endHour: 24 } }),
      ).toThrow();
    });

    it('rejects endHour outside the 1-24 range', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({ timeWindow: { startHour: 0, endHour: 0 } }),
      ).toThrow();
    });

    it('rejects an empty days array', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({
          timeWindow: { startHour: 9, endHour: 17, days: [] },
        }),
      ).toThrow('timeWindow.days must not be empty');
    });

    it('rejects a day outside the 0-6 range', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({
          timeWindow: { startHour: 9, endHour: 17, days: [7] },
        }),
      ).toThrow();
    });

    it('rejects non-integer hours', () => {
      expect(() =>
        policyConfigurationSchemaStrict.parse({ timeWindow: { startHour: 9.5, endHour: 17 } }),
      ).toThrow();
    });
  });

  describe('type-safety on boolean flags', () => {
    it('rejects non-boolean emergencyLock', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ emergencyLock: 'yes' })).toThrow();
    });

    it('rejects non-boolean requiresApproval', () => {
      expect(() => policyConfigurationSchemaStrict.parse({ requiresApproval: 1 })).toThrow();
    });
  });
});

describe('createPolicySchema (incoming policy rule payloads)', () => {
  const baseInput = {
    name: 'Max 1000 USDC per transaction',
    type: PolicyType.MAX_AMOUNT,
  };

  it('accepts a valid policy with a strict-valid configuration', () => {
    const result = createPolicySchema.parse({
      ...baseInput,
      configuration: { maxAmount: 1000, allowedAssets: ['USDC'] },
    });
    expect(result.configuration.maxAmount).toBe(1000);
  });

  it('defaults configuration to an empty object when omitted', () => {
    const result = createPolicySchema.parse({ ...baseInput });
    expect(result.configuration).toEqual({});
  });

  it('rejects a malformed configuration inside the payload', () => {
    expect(() =>
      createPolicySchema.parse({
        ...baseInput,
        configuration: { allowedAssets: ['USDC'], blockedAssets: ['USDC'] },
      }),
    ).toThrow('Asset cannot be both in allowedAssets and blockedAssets');
  });

  it('rejects a negative maxAmount inside the payload configuration', () => {
    expect(() =>
      createPolicySchema.parse({ ...baseInput, configuration: { maxAmount: -100 } }),
    ).toThrow();
  });

  it('rejects unexpected top-level properties (strict payload)', () => {
    expect(() => createPolicySchema.parse({ ...baseInput, rogue: 'field' })).toThrow();
  });

  it('rejects an unknown property nested in configuration (strict rule)', () => {
    expect(() =>
      createPolicySchema.parse({ ...baseInput, configuration: { spicy: true } }),
    ).toThrow();
  });
});

describe('updatePolicySchema (partial policy rule payloads)', () => {
  it('accepts a partial update of only the rule configuration', () => {
    const result = updatePolicySchema.parse({
      configuration: { dailyLimit: 500, requiresApproval: true },
    });
    expect(result.configuration).toMatchObject({ dailyLimit: 500, requiresApproval: true });
  });

  it('rejects an invalid rule configuration in a partial update', () => {
    expect(() =>
      updatePolicySchema.parse({
        configuration: { approvalThreshold: 500 },
      }),
    ).toThrow('approvalThreshold requires requiresApproval to be true');
  });

  it('rejects unknown top-level properties in a partial update', () => {
    expect(() => updatePolicySchema.parse({ unknownKey: 1 })).toThrow();
  });
});