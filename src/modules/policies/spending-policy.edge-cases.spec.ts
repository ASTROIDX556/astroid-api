import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Policy } from '@prisma/client';
import { PolicyService } from './policy.service';
import { PolicyEngine } from './policy.engine';
import { PriceOracleService } from './price-oracle.service';
import { AssetRegistryService } from './asset-registry.service';
import { SpendingPolicyService } from './spending-policy.service';
import { SpendingPolicyRepository } from './spending-policy.repository';
import { EventBusService } from '../../events/event-bus.service';
import { ONE_STROOP } from '../../utils/decimal.util';
import { EvaluablePolicy } from './policy.types';

const ISSUER_A = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ISSUER_B = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const VALID_RECIPIENT = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3IFBSDXWNLU3';
const VALID_RECIPIENT_LOWER = VALID_RECIPIENT.toLowerCase();
const OTHER_RECIPIENT = 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSBR54EBUSXZL6KADHXRFLHX7QH';

function createPolicyRow(overrides: Partial<Policy> = {}): Policy {
  return {
    id: 'policy-test-1',
    organizationId: 'org-test',
    agentId: 'agent-test',
    name: 'Spending Limit Policy',
    description: null,
    type: 'MAX_AMOUNT',
    configuration: {},
    priority: 100,
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    overrideLimit: null,
    overrideUntil: null,
    originalLimit: null,
    ...overrides,
  } as unknown as Policy;
}

describe('Spending policy evaluation edge cases (Issue #553)', () => {
  let policyService: PolicyService;
  let spendingPolicyService: SpendingPolicyService;
  let mockRepo: {
    findApplicableForEvaluation: ReturnType<typeof vi.fn>;
    findActiveForEvaluation: ReturnType<typeof vi.fn>;
    findActiveForEvaluationByAgent: ReturnType<typeof vi.fn>;
    recordEvaluationAudit: ReturnType<typeof vi.fn>;
    sumSpentInWindow: ReturnType<typeof vi.fn>;
    sumSpendSince: ReturnType<typeof vi.fn>;
  };
  let mockEventBus: { emit: ReturnType<typeof vi.fn> };
  let mockPriceOracle: { convert: ReturnType<typeof vi.fn> };
  let mockAssetRegistry: { canonicalize: ReturnType<typeof vi.fn> };

  const engine = new PolicyEngine();

  beforeEach(() => {
    mockRepo = {
      findApplicableForEvaluation: vi.fn().mockResolvedValue([]),
      findActiveForEvaluation: vi.fn().mockResolvedValue([]),
      findActiveForEvaluationByAgent: vi.fn().mockResolvedValue([]),
      recordEvaluationAudit: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      sumSpentInWindow: vi.fn().mockResolvedValue(0),
      sumSpendSince: vi.fn().mockResolvedValue(0),
    };

    spendingPolicyService = new SpendingPolicyService(
      mockRepo as unknown as SpendingPolicyRepository,
    );

    mockEventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    mockPriceOracle = {
      convert: vi.fn().mockImplementation(async (amount: number) => amount),
    };
    mockAssetRegistry = {
      canonicalize: vi.fn().mockImplementation((asset: string) => asset),
    };

    policyService = new PolicyService(
      spendingPolicyService,
      engine,
      mockEventBus as unknown as EventBusService,
      mockPriceOracle as unknown as PriceOracleService,
      mockAssetRegistry as unknown as AssetRegistryService,
    );
  });

  // ── 1. Amount boundary: exact limit vs one stroop above/below ───────────────

  describe('Per-transaction amount boundaries (exact limit vs 1 stroop)', () => {
    const maxLimit = 10;
    const minLimit = 1;

    const maxCases = [
      { desc: 'one stroop below max amount', amount: maxLimit - ONE_STROOP, expectedPassed: true },
      { desc: 'exactly equal to max amount', amount: maxLimit, expectedPassed: true },
      { desc: 'one stroop above max amount', amount: maxLimit + ONE_STROOP, expectedPassed: false },
      { desc: 'substantially above max amount', amount: 15, expectedPassed: false },
    ];

    it.each(maxCases)('evaluates $desc: $amount (max: 10)', async ({ amount, expectedPassed }) => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ configuration: { maxAmount: maxLimit } }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(expectedPassed);
      if (!expectedPassed) {
        expect(result.violations[0].code).toBe('MAX_AMOUNT_EXCEEDED');
      }
    });

    const minCases = [
      { desc: 'substantially below min amount', amount: 0.5, expectedPassed: false },
      { desc: 'one stroop below min amount', amount: minLimit - ONE_STROOP, expectedPassed: false },
      { desc: 'exactly equal to min amount', amount: minLimit, expectedPassed: true },
      { desc: 'one stroop above min amount', amount: minLimit + ONE_STROOP, expectedPassed: true },
    ];

    it.each(minCases)('evaluates $desc: $amount (min: 1)', async ({ amount, expectedPassed }) => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ configuration: { minAmount: minLimit } }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(expectedPassed);
      if (!expectedPassed) {
        expect(result.violations[0].code).toBe('MIN_AMOUNT_NOT_MET');
      }
    });
  });

  // ── 2. Rolling window boundaries (daily, weekly, monthly) ───────────────────

  describe('Rolling window budget boundaries (spent + amount vs limit)', () => {
    const dailyLimit = 100;
    const spentToday = 80;

    const periodicBoundaryCases = [
      {
        desc: 'total exactly equal to daily limit',
        spent: spentToday,
        amount: 20,
        limit: dailyLimit,
        window: 'daily',
        expectedPassed: true,
      },
      {
        desc: 'total one stroop above daily limit',
        spent: spentToday,
        amount: 20 + ONE_STROOP,
        limit: dailyLimit,
        window: 'daily',
        expectedPassed: false,
      },
      {
        desc: 'total exactly equal to weekly limit',
        spent: 450,
        amount: 50,
        limit: 500,
        window: 'weekly',
        expectedPassed: true,
      },
      {
        desc: 'total one stroop above weekly limit',
        spent: 450,
        amount: 50 + ONE_STROOP,
        limit: 500,
        window: 'weekly',
        expectedPassed: false,
      },
      {
        desc: 'total exactly equal to monthly limit',
        spent: 990,
        amount: 10,
        limit: 1000,
        window: 'monthly',
        expectedPassed: true,
      },
      {
        desc: 'total one stroop above monthly limit',
        spent: 990,
        amount: 10 + ONE_STROOP,
        limit: 1000,
        window: 'monthly',
        expectedPassed: false,
      },
    ];

    it.each(periodicBoundaryCases)(
      'evaluates $desc ($window window)',
      async ({ spent, amount, limit, window, expectedPassed }) => {
        const configKey = `${window}Limit`;
        const intentKey = window === 'daily' ? 'spentToday' : window === 'weekly' ? 'spentThisWeek' : 'spentThisMonth';

        mockRepo.findApplicableForEvaluation.mockResolvedValue([
          createPolicyRow({ configuration: { [configKey]: limit } }),
        ]);

        const result = await policyService.evaluateIntent({
          organizationId: 'org-test',
          agentId: 'agent-test',
          asset: 'XLM',
          amount,
          recipientAddress: VALID_RECIPIENT,
          [intentKey]: spent,
        });

        expect(result.passed).toBe(expectedPassed);
        if (!expectedPassed) {
          const expectedCode = `${window.toUpperCase()}_LIMIT_EXCEEDED`;
          expect(result.violations[0].code).toBe(expectedCode);
        }
      },
    );

    it('avoids floating point addition drift when evaluating periodic limits (0.1 + 0.2 vs 0.3)', async () => {
      // In JS: 0.1 + 0.2 === 0.30000000000000004 (> 0.3).
      // With stroop integer arithmetic, 1_000_000n + 2_000_000n === 3_000_000n (exact).
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ configuration: { dailyLimit: 0.3 } }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 0.2,
        spentToday: 0.1,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('rejects 0.1 + 0.2000001 against limit 0.3 (one stroop above)', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ configuration: { dailyLimit: 0.3 } }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 0.2 + ONE_STROOP,
        spentToday: 0.1,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('DAILY_LIMIT_EXCEEDED');
    });
  });

  // ── 3. Asset mismatch & asset allow/deny list ──────────────────────────────

  describe('Asset matching and mismatch authorization', () => {
    it.each([
      {
        desc: 'policy allowing USDC rejects XLM',
        allowedAssets: ['USDC'],
        blockedAssets: undefined,
        intentAsset: 'XLM',
        expectedPassed: false,
        expectedCode: 'ASSET_NOT_ALLOWED',
      },
      {
        desc: 'policy allowing USDC allows USDC',
        allowedAssets: ['USDC'],
        blockedAssets: undefined,
        intentAsset: 'USDC',
        expectedPassed: true,
      },
      {
        desc: 'policy allowing USDC allows lowercase usdc (case-insensitive)',
        allowedAssets: ['USDC'],
        blockedAssets: undefined,
        intentAsset: 'usdc',
        expectedPassed: true,
      },
      {
        desc: 'policy allowing bare USDC allows credit asset USDC:ISSUER_A',
        allowedAssets: ['USDC'],
        blockedAssets: undefined,
        intentAsset: `USDC:${ISSUER_A}`,
        expectedPassed: true,
      },
      {
        desc: 'policy allowing specific USDC:ISSUER_A rejects USDC:ISSUER_B (issuer mismatch)',
        allowedAssets: [`USDC:${ISSUER_A}`],
        blockedAssets: undefined,
        intentAsset: `USDC:${ISSUER_B}`,
        expectedPassed: false,
        expectedCode: 'ASSET_NOT_ALLOWED',
      },
      {
        desc: 'policy allowing specific USDC:ISSUER_A allows USDC:ISSUER_A',
        allowedAssets: [`USDC:${ISSUER_A}`],
        blockedAssets: undefined,
        intentAsset: `USDC:${ISSUER_A}`,
        expectedPassed: true,
      },
      {
        desc: 'policy blocking XLM blocks XLM',
        allowedAssets: undefined,
        blockedAssets: ['XLM'],
        intentAsset: 'XLM',
        expectedPassed: false,
        expectedCode: 'ASSET_BLOCKED',
      },
      {
        desc: 'policy blocking bare USDC blocks credit asset USDC:ISSUER_A',
        allowedAssets: undefined,
        blockedAssets: ['USDC'],
        intentAsset: `USDC:${ISSUER_A}`,
        expectedPassed: false,
        expectedCode: 'ASSET_BLOCKED',
      },
      {
        desc: 'policy blocking specific USDC:ISSUER_A allows USDC:ISSUER_B',
        allowedAssets: undefined,
        blockedAssets: [`USDC:${ISSUER_A}`],
        intentAsset: `USDC:${ISSUER_B}`,
        expectedPassed: true,
      },
    ])('evaluates $desc', async ({ allowedAssets, blockedAssets, intentAsset, expectedPassed, expectedCode }) => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({
          configuration: {
            allowedAssets,
            blockedAssets,
          },
        }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: intentAsset,
        amount: 10,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(expectedPassed);
      if (!expectedPassed && expectedCode) {
        expect(result.violations[0].code).toBe(expectedCode);
      }
    });
  });

  // ── 4. Destination allow/deny lists (case sensitivity & exact vs prefix) ───

  describe('Destination allow/deny lists (case sensitivity and exact vs prefix)', () => {
    it.each([
      {
        desc: 'exact match on allowed recipient passes',
        allowedRecipients: [VALID_RECIPIENT],
        blockedRecipients: undefined,
        recipient: VALID_RECIPIENT,
        expectedPassed: true,
      },
      {
        desc: 'case-insensitive match on allowed recipient passes (lowercase input)',
        allowedRecipients: [VALID_RECIPIENT],
        blockedRecipients: undefined,
        recipient: VALID_RECIPIENT_LOWER,
        expectedPassed: true,
      },
      {
        desc: 'prefix of allowed recipient does NOT match (exact match required)',
        allowedRecipients: [VALID_RECIPIENT],
        blockedRecipients: undefined,
        recipient: VALID_RECIPIENT.slice(0, 20),
        expectedPassed: false,
        expectedCode: 'RECIPIENT_NOT_ALLOWED',
      },
      {
        desc: 'recipient with allowed recipient as prefix does NOT match (exact match required)',
        allowedRecipients: [VALID_RECIPIENT.slice(0, 20)],
        blockedRecipients: undefined,
        recipient: VALID_RECIPIENT,
        expectedPassed: false,
        expectedCode: 'RECIPIENT_NOT_ALLOWED',
      },
      {
        desc: 'exact match on blocked recipient is blocked',
        allowedRecipients: undefined,
        blockedRecipients: [VALID_RECIPIENT],
        recipient: VALID_RECIPIENT,
        expectedPassed: false,
        expectedCode: 'RECIPIENT_BLOCKED',
      },
      {
        desc: 'case-insensitive match on blocked recipient is blocked (lowercase cannot bypass blocklist)',
        allowedRecipients: undefined,
        blockedRecipients: [VALID_RECIPIENT],
        recipient: VALID_RECIPIENT_LOWER,
        expectedPassed: false,
        expectedCode: 'RECIPIENT_BLOCKED',
      },
      {
        desc: 'address differing by one character from blocked recipient is allowed',
        allowedRecipients: undefined,
        blockedRecipients: [VALID_RECIPIENT],
        recipient: OTHER_RECIPIENT,
        expectedPassed: true,
      },
    ])('evaluates $desc', async ({ allowedRecipients, blockedRecipients, recipient, expectedPassed, expectedCode }) => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({
          configuration: {
            allowedRecipients,
            blockedRecipients,
          },
        }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 10,
        recipientAddress: recipient,
      });

      expect(result.passed).toBe(expectedPassed);
      if (!expectedPassed && expectedCode) {
        expect(result.violations[0].code).toBe(expectedCode);
      }
    });
  });

  // ── 5. Time window boundary evaluation ─────────────────────────────────────

  describe('Time window boundaries (startHour inclusive, endHour exclusive, days)', () => {
    // Allowed window: 09:00 - 17:00 UTC, Mon-Fri (1-5)
    // 2026-01-02 was Friday (day 5), 2026-01-03 was Saturday (day 6), 2026-01-05 was Monday (day 1)
    const timeWindowConfig = {
      startHour: 9,
      endHour: 17,
      days: [1, 2, 3, 4, 5],
      timezone: 'UTC',
    };

    const timeBoundaryCases = [
      {
        desc: 'just before startHour (08:59:59.999)',
        at: new Date('2026-01-02T08:59:59.999Z'),
        expectedPassed: false,
      },
      {
        desc: 'exactly at startHour (09:00:00.000) - inclusive start boundary',
        at: new Date('2026-01-02T09:00:00.000Z'),
        expectedPassed: true,
      },
      {
        desc: 'midday within window (12:30:00.000)',
        at: new Date('2026-01-02T12:30:00.000Z'),
        expectedPassed: true,
      },
      {
        desc: 'just before endHour (16:59:59.999) - inside window',
        at: new Date('2026-01-02T16:59:59.999Z'),
        expectedPassed: true,
      },
      {
        desc: 'exactly at endHour (17:00:00.000) - exclusive end boundary',
        at: new Date('2026-01-02T17:00:00.000Z'),
        expectedPassed: false,
      },
      {
        desc: 'Friday 23:59:59 outside hour window',
        at: new Date('2026-01-02T23:59:59.000Z'),
        expectedPassed: false,
      },
      {
        desc: 'Saturday 12:00:00 within hour window but disallowed day (weekend)',
        at: new Date('2026-01-03T12:00:00.000Z'),
        expectedPassed: false,
      },
      {
        desc: 'Monday 09:00:00 boundary reopening after weekend',
        at: new Date('2026-01-05T09:00:00.000Z'),
        expectedPassed: true,
      },
    ];

    it.each(timeBoundaryCases)('evaluates $desc', async ({ at, expectedPassed }) => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ configuration: { timeWindow: timeWindowConfig } }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 10,
        recipientAddress: VALID_RECIPIENT,
        at,
      });

      expect(result.passed).toBe(expectedPassed);
      if (!expectedPassed) {
        expect(result.violations[0].code).toBe('OUTSIDE_TIME_WINDOW');
      }
    });
  });

  // ── 6. Explicit fallback when no matching policy ───────────────────────────

  describe('Explicit fallback behavior when no policies match', () => {
    it('falls through to documented default (allow, unconstrained) when repository returns no policies', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 1_000_000,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(true);
      expect(result.requiresApproval).toBe(false);
      expect(result.violations).toHaveLength(0);
      expect(result.evaluatedPolicyIds).toEqual([]);
      expect(result.matchedPolicyId).toBeUndefined();
    });

    it('falls through to documented default when policies exist for the org but target another agent', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ agentId: 'other-agent-only', configuration: { maxAmount: 1 } }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 500,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.evaluatedPolicyIds).toEqual([]);
    });

    it('fails closed when an applicable policy is disabled', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ enabled: false, configuration: { maxAmount: 100 } }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 10,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('POLICY_DISABLED');
      expect(result.evaluatedPolicyIds).toContain('policy-test-1');
    });

    it('fails closed when an applicable policy has a zero limit (zero-limit denies all)', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ configuration: { maxAmount: 0 } }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 0,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('ZERO_LIMIT_DENIED');
    });
  });

  // ── 7. Multiple matching policies: most restrictive wins ───────────────────

  describe('Multiple matching policies (most restrictive result wins)', () => {
    it('applies the most restrictive maxAmount across matching policies', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ id: 'policy-broad', priority: 200, configuration: { maxAmount: 100 } }),
        createPolicyRow({ id: 'policy-tight', priority: 100, configuration: { maxAmount: 50 } }),
      ]);

      // Amount 40 passes both
      const allowResult = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 40,
        recipientAddress: VALID_RECIPIENT,
      });
      expect(allowResult.passed).toBe(true);

      // Amount 60 passes policy-broad (100) but is rejected by policy-tight (50) -> tightest wins
      const rejectResult = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 60,
        recipientAddress: VALID_RECIPIENT,
      });
      expect(rejectResult.passed).toBe(false);
      expect(rejectResult.violations).toHaveLength(1);
      expect(rejectResult.violations[0].policyId).toBe('policy-tight');
      expect(rejectResult.violations[0].code).toBe('MAX_AMOUNT_EXCEEDED');
    });

    it('applies the most restrictive periodic limit across matching policies', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ id: 'policy-broad-daily', priority: 200, configuration: { dailyLimit: 1000 } }),
        createPolicyRow({ id: 'policy-tight-daily', priority: 100, configuration: { dailyLimit: 500 } }),
      ]);

      // Prior spend: 400. New amount: 150. Total: 550.
      // Fits under 1000, but exceeds 500.
      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 150,
        spentToday: 400,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(false);
      expect(result.violations[0].policyId).toBe('policy-tight-daily');
      expect(result.violations[0].code).toBe('DAILY_LIMIT_EXCEEDED');
    });

    it('demands approval if ANY matching policy requires it', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ id: 'p-no-approval', priority: 100, configuration: { maxAmount: 1000 } }),
        createPolicyRow({
          id: 'p-approval',
          priority: 200,
          configuration: { approvalThreshold: 200 },
        }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 250,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('denies the transaction if one policy allows the recipient but another blocks it', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({
          id: 'p-allowlist',
          priority: 100,
          configuration: { allowedRecipients: [VALID_RECIPIENT, OTHER_RECIPIENT] },
        }),
        createPolicyRow({
          id: 'p-blocklist',
          priority: 200,
          configuration: { blockedRecipients: [OTHER_RECIPIENT] },
        }),
      ]);

      // OTHER_RECIPIENT is in p-allowlist, but blocked by p-blocklist -> blocked wins
      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 10,
        recipientAddress: OTHER_RECIPIENT,
      });

      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('RECIPIENT_BLOCKED');
      expect(result.violations[0].policyId).toBe('p-blocklist');
    });

    it('fails closed if ANY applicable policy is disabled', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ id: 'p-active', priority: 100, enabled: true, configuration: { maxAmount: 1000 } }),
        createPolicyRow({ id: 'p-disabled', priority: 200, enabled: false, configuration: {} }),
      ]);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 10,
        recipientAddress: VALID_RECIPIENT,
      });

      expect(result.passed).toBe(false);
      expect(result.violations[0].code).toBe('POLICY_DISABLED');
      expect(result.violations[0].policyId).toBe('p-disabled');
    });
  });

  // ── 8. Rule groups with amount comparisons in stroops ──────────────────────

  describe('Multi-condition rule groups with stroop comparisons', () => {
    it('evaluates rule group amount condition at boundary using stroops', () => {
      const p: EvaluablePolicy = {
        id: 'p-rules',
        name: 'Rule policy',
        priority: 100,
        enabled: true,
        configuration: {
          rules: [
            {
              id: 'max-spend-guard',
              logic: 'AND',
              conditions: [
                { field: 'amount', operator: 'lte', value: 10 },
              ],
            },
          ],
        },
      };

      // 10 is lte 10 -> passes
      expect(engine.evaluate({ organizationId: 'org', asset: 'XLM', amount: 10, recipientAddress: 'G' }, [p]).passed).toBe(true);

      // 10 + ONE_STROOP exceeds 10 -> fails
      expect(engine.evaluate({ organizationId: 'org', asset: 'XLM', amount: 10 + ONE_STROOP, recipientAddress: 'G' }, [p]).passed).toBe(false);
    });
  });

  // ── 9. Velocity check in SpendingPolicyService ─────────────────────────────

  describe('SpendingPolicyService.checkVelocityLimit with stroop comparisons', () => {
    it('allows spend when spent + amount exactly equals dailyLimit', async () => {
      mockRepo.findActiveForEvaluationByAgent.mockResolvedValue([
        { id: 'p1', configuration: { dailyLimit: 0.3 } },
      ]);
      mockRepo.sumSpentInWindow.mockResolvedValue(0.1);

      // 0.1 + 0.2 === 0.3 (would fail in standard float without stroops)
      await expect(
        spendingPolicyService.checkVelocityLimit('agent-test', 0.2, 'XLM'),
      ).resolves.toBeUndefined();
    });

    it('rejects spend when spent + amount is one stroop above dailyLimit', async () => {
      mockRepo.findActiveForEvaluationByAgent.mockResolvedValue([
        { id: 'p1', configuration: { dailyLimit: 0.3 } },
      ]);
      mockRepo.sumSpentInWindow.mockResolvedValue(0.1);

      await expect(
        spendingPolicyService.checkVelocityLimit('agent-test', 0.2 + ONE_STROOP, 'XLM'),
      ).rejects.toThrow('Daily velocity limit exceeded');
    });

    it('delegates checkVelocityLimit through PolicyService facade', async () => {
      mockRepo.findActiveForEvaluationByAgent.mockResolvedValue([
        { id: 'p1', configuration: { dailyLimit: 100 } },
      ]);
      mockRepo.sumSpentInWindow.mockResolvedValue(50);

      await expect(
        policyService.checkVelocityLimit('org-test', 'agent-test', 20, 'XLM', 'actor-1'),
      ).resolves.toBeUndefined();
    });

    it('delegates listActiveForEvaluation through SpendingPolicyService', async () => {
      mockRepo.findActiveForEvaluation.mockResolvedValue([{ id: 'p1' }]);
      const active = await spendingPolicyService.listActiveForEvaluation('org-test', 'agent-test');
      expect(active).toEqual([{ id: 'p1' }]);
      expect(mockRepo.findActiveForEvaluation).toHaveBeenCalledWith('org-test', 'agent-test');
    });
  });

  // ── 10. Audit recording and multi-asset currency conversions ───────────────

  describe('Audit recording and multi-asset conversions', () => {
    it('records evaluation audit when actorId is provided', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({ id: 'p-audit', configuration: { maxAmount: 100 } }),
      ]);

      const result = await policyService.evaluateIntent(
        {
          organizationId: 'org-test',
          agentId: 'agent-test',
          asset: 'XLM',
          amount: 50,
          recipientAddress: VALID_RECIPIENT,
        },
        'actor-123',
      );

      expect(result.passed).toBe(true);
      expect(mockRepo.recordEvaluationAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-test',
          userId: 'actor-123',
          policyId: 'p-audit',
        }),
      );
    });

    it('converts spentByAsset when a policy is denominated in baseCurrency', async () => {
      mockRepo.findApplicableForEvaluation.mockResolvedValue([
        createPolicyRow({
          id: 'p-base-usd',
          configuration: { baseCurrency: 'USD', dailyLimit: 500 },
        }),
      ]);
      mockPriceOracle.convert.mockImplementation(async (amount: number) => amount * 2);

      const result = await policyService.evaluateIntent({
        organizationId: 'org-test',
        agentId: 'agent-test',
        asset: 'XLM',
        amount: 50,
        recipientAddress: VALID_RECIPIENT,
        spentByAsset: {
          XLM: { spentToday: 100, spentThisWeek: 200, spentThisMonth: 300 },
        },
      });

      expect(result.passed).toBe(true);
      expect(mockPriceOracle.convert).toHaveBeenCalledWith(100, 'XLM', 'USD');
      expect(mockPriceOracle.convert).toHaveBeenCalledWith(200, 'XLM', 'USD');
      expect(mockPriceOracle.convert).toHaveBeenCalledWith(300, 'XLM', 'USD');
    });
  });
});
