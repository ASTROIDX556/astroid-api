import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { TransactionStatus } from '@prisma/client';
import { SpendingLimitService } from '../spending-limit.service';
import { PolicyService } from '../../policies/policy.service';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../../database/prisma.service';
import { RedisLock } from '../../../common/locks/redis-lock.util';
import { PolicyViolationException } from '../../../common/exceptions/domain.exception';
import { TransactionIntent } from '../../policies/policy.types';
import { EXCLUDED_SPEND_STATUSES } from '../../policies/spending-window.util';
import { Decimal } from '@prisma/client/runtime/library';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_STELLAR = 'GDEGSXLGANKHK7QFOV63XCBHBTZ3YRKUJV7ZB7JMSJQB5CNBRLL5QIG5';

function makeIntent(overrides: Partial<TransactionIntent> = {}): TransactionIntent {
  return {
    organizationId: 'org-1',
    agentId: 'agent-1',
    walletId: 'wallet-1',
    asset: 'USDC',
    amount: 100,
    recipientAddress: VALID_STELLAR,
    at: new Date('2026-09-30T10:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPolicyService = {
  evaluateIntent: vi.fn(),
};

const mockAuditService = {
  record: vi.fn(),
};

// Prisma mock — returns Decimal sums for the three aggregate windows
const makeDecimal = (n: number) => ({ toNumber: () => n } as unknown as Decimal);

const mockPrismaService = {
  $transaction: vi.fn(),
  policy: {
    findMany: vi.fn(),
  },
  transaction: {
    aggregate: vi.fn(),
  },
};

/**
 * RedisLock mock. By default it runs the callback straight through (no
 * serialisation) so individual tests stay simple; the concurrency test overrides
 * it with a real serialising implementation to prove the lock actually orders
 * concurrent checks.
 */
const mockRedisLock = {
  withLock: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SpendingLimitService', () => {
  let service: SpendingLimitService;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpendingLimitService,
        { provide: PolicyService, useValue: mockPolicyService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RedisLock, useValue: mockRedisLock },
      ],
    }).compile();

    service = module.get<SpendingLimitService>(SpendingLimitService);
  });

  // ── aggregateSpend ────────────────────────────────────────────────────────

  describe('aggregateSpend', () => {
    it('returns zeros when no transactions exist for the agent', async () => {
      mockPrismaService.$transaction.mockResolvedValue([
        { _sum: { amount: null } },
        { _sum: { amount: null } },
        { _sum: { amount: null } },
      ]);

      const result = await service.aggregateSpend('agent-1', 'USDC');

      expect(result).toEqual({ spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 });
    });

    it('converts Prisma Decimal sums to numbers correctly', async () => {
      mockPrismaService.$transaction.mockResolvedValue([
        { _sum: { amount: makeDecimal(50) } },
        { _sum: { amount: makeDecimal(200) } },
        { _sum: { amount: makeDecimal(800) } },
      ]);

      const result = await service.aggregateSpend('agent-1', 'USDC');

      expect(result).toEqual({ spentToday: 50, spentThisWeek: 200, spentThisMonth: 800 });
    });

    it('runs all three aggregate queries in a single prisma $transaction call', async () => {
      mockPrismaService.$transaction.mockResolvedValue([
        { _sum: { amount: null } },
        { _sum: { amount: null } },
        { _sum: { amount: null } },
      ]);

      await service.aggregateSpend('agent-1', 'XLM');

      expect(mockPrismaService.$transaction).toHaveBeenCalledTimes(1);
      // The array passed to $transaction should contain 3 query promises
      const queryArray = mockPrismaService.$transaction.mock.calls[0][0] as unknown[];
      expect(queryArray).toHaveLength(3);
    });

    it('counts pending and in-flight spend (excludes only terminal-failed)', async () => {
      mockPrismaService.$transaction.mockResolvedValue([
        { _sum: { amount: null } },
        { _sum: { amount: null } },
        { _sum: { amount: null } },
      ]);

      await service.aggregateSpend('agent-1', 'USDC');

      const dayWhere = mockPrismaService.transaction.aggregate.mock.calls[0][0].where;
      // The window excludes only terminal-failed states...
      expect(dayWhere.status).toEqual({ notIn: [...EXCLUDED_SPEND_STATUSES] });
      // ...so PENDING (must count, per the issue) and DRAFT are NOT excluded...
      expect(dayWhere.status.notIn).not.toContain(TransactionStatus.PENDING);
      expect(dayWhere.status.notIn).not.toContain(TransactionStatus.DRAFT);
      // ...and FAILED/REJECTED/CANCELLED/EXPIRED ARE excluded.
      expect(dayWhere.status.notIn).toEqual(
        expect.arrayContaining([
          TransactionStatus.FAILED,
          TransactionStatus.REJECTED,
          TransactionStatus.CANCELLED,
          TransactionStatus.EXPIRED,
        ]),
      );
    });

    it('scopes the aggregate by organization when one is supplied', async () => {
      mockPrismaService.$transaction.mockResolvedValue([
        { _sum: { amount: null } },
        { _sum: { amount: null } },
        { _sum: { amount: null } },
      ]);

      await service.aggregateSpend('agent-1', 'USDC', 'org-1');

      const dayWhere = mockPrismaService.transaction.aggregate.mock.calls[0][0].where;
      expect(dayWhere.organizationId).toBe('org-1');
    });

    it('omits the organization filter when no organization is supplied', async () => {
      mockPrismaService.$transaction.mockResolvedValue([
        { _sum: { amount: null } },
        { _sum: { amount: null } },
        { _sum: { amount: null } },
      ]);

      await service.aggregateSpend('agent-1', 'USDC');

      const dayWhere = mockPrismaService.transaction.aggregate.mock.calls[0][0].where;
      expect(dayWhere).not.toHaveProperty('organizationId');
    });
  });

  // ── hasSpendingLimitPolicy ────────────────────────────────────────────────

  describe('hasSpendingLimitPolicy', () => {
    it('returns true when a policy with dailyLimit exists', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([
        { configuration: { dailyLimit: 500 } },
      ]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(true);
    });

    it('returns true when a policy with weeklyLimit exists', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([
        { configuration: { weeklyLimit: 2000 } },
      ]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(true);
    });

    it('returns true when a policy with monthlyLimit exists', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([
        { configuration: { monthlyLimit: 10000 } },
      ]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(true);
    });

    it('returns false when no policies define periodic limits', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([
        { configuration: { maxAmount: 1000, allowedAssets: ['USDC'] } },
      ]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(false);
    });

    it('returns false when no policies exist at all', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(false);
    });

    it('returns true when only a disabled policy declares a dailyLimit (fail closed)', async () => {
      mockPrismaService.policy.findMany.mockResolvedValue([
        { enabled: false, configuration: { dailyLimit: 500 } },
      ]);

      const result = await service.hasSpendingLimitPolicy('org-1', 'agent-1');
      expect(result).toBe(true);
    });
  });

  // ── evaluateSpendingLimits ────────────────────────────────────────────────

  describe('evaluateSpendingLimits', () => {
    describe('no-op paths', () => {
      it('returns early (no-op) when intent has no agentId', async () => {
        const intent = makeIntent({ agentId: undefined });

        await service.evaluateSpendingLimits(intent, 'user-1');

        expect(mockPrismaService.policy.findMany).not.toHaveBeenCalled();
        expect(mockPolicyService.evaluateIntent).not.toHaveBeenCalled();
      });

      it('returns early (no-op) when no periodic limit policies are configured', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { maxAmount: 5000 } },
        ]);

        await service.evaluateSpendingLimits(makeIntent(), 'user-1');

        expect(mockPolicyService.evaluateIntent).not.toHaveBeenCalled();
        expect(mockAuditService.record).not.toHaveBeenCalled();
      });
    });

    describe('policy passes', () => {
      beforeEach(() => {
        // Org has a daily limit policy
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { dailyLimit: 500 } },
        ]);
        // Agent has spent 50 today
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(50) } },
          { _sum: { amount: makeDecimal(50) } },
          { _sum: { amount: makeDecimal(50) } },
        ]);
      });

      it('does not throw when spend + amount is within daily limit', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
          evaluatedPolicyIds: ['policy-1'],
        });

        // 50 already spent + 100 pending = 150, limit is 500 — should pass
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).resolves.toBeUndefined();

        expect(mockAuditService.record).not.toHaveBeenCalled();
      });

      it('enriches intent with real spend aggregates before calling evaluateIntent', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
          evaluatedPolicyIds: ['policy-1'],
        });

        await service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1');

        const intentPassedToEngine = mockPolicyService.evaluateIntent.mock.calls[0][0] as TransactionIntent;
        expect(intentPassedToEngine.spentToday).toBe(50);
        expect(intentPassedToEngine.spentThisWeek).toBe(50);
        expect(intentPassedToEngine.spentThisMonth).toBe(50);
        expect(intentPassedToEngine.amount).toBe(100);
      });
    });

    describe('limit exceeded — daily', () => {
      beforeEach(() => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { dailyLimit: 500 } },
        ]);
        // 450 already spent today
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(450) } },
          { _sum: { amount: makeDecimal(450) } },
          { _sum: { amount: makeDecimal(450) } },
        ]);
      });

      it('throws PolicyViolationException when daily limit would be exceeded', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });

        // 450 + 100 = 550 > 500
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);
      });

      it('throws with error code POLICY_VIOLATION', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });

        let caughtError: PolicyViolationException | undefined;
        try {
          await service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1');
        } catch (err) {
          caughtError = err as PolicyViolationException;
        }

        expect(caughtError).toBeInstanceOf(PolicyViolationException);
        expect(caughtError?.code).toBe('POLICY_VIOLATION');
      });

      it('throws with HTTP status 422 on daily limit violation', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });

        let caughtError: PolicyViolationException | undefined;
        try {
          await service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1');
        } catch (err) {
          caughtError = err as PolicyViolationException;
        }

        expect(caughtError?.getStatus()).toBe(422);
      });

      it('writes a SPENDING_LIMIT_EXCEEDED audit log entry on violation', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });
        mockAuditService.record.mockResolvedValue(undefined);

        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);

        expect(mockAuditService.record).toHaveBeenCalledTimes(1);
        const auditCall = mockAuditService.record.mock.calls[0][0] as Record<string, unknown>;
        expect(auditCall.action).toBe('SPENDING_LIMIT_EXCEEDED');
        expect(auditCall.entity).toBe('transaction');
        expect(auditCall.userId).toBe('user-1');
        expect(auditCall.organizationId).toBe('org-1');
      });

      it('includes violation codes in the audit log newValue', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });
        mockAuditService.record.mockResolvedValue(undefined);

        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);

        const auditCall = mockAuditService.record.mock.calls[0][0] as Record<string, unknown>;
        const newValue = auditCall.newValue as Record<string, unknown>;
        expect((newValue.violations as Array<{ code: string }>)[0].code).toBe('DAILY_LIMIT_EXCEEDED');
        expect((newValue.aggregates as Record<string, number>).spentToday).toBe(450);
      });

      it('still throws PolicyViolationException even when audit log write fails', async () => {
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'Daily Spend Cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 550 exceeds limit 500',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });
        // Simulate an audit service failure
        mockAuditService.record.mockRejectedValue(new Error('DB connection lost'));

        // The transaction must still be blocked — audit failures are non-fatal
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);
      });
    });

    describe('limit exceeded — weekly', () => {
      it('throws PolicyViolationException when weekly limit would be exceeded', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { weeklyLimit: 1000 } },
        ]);
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(50) } },
          { _sum: { amount: makeDecimal(950) } },   // 950 this week
          { _sum: { amount: makeDecimal(950) } },
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-2',
              policyName: 'Weekly Spend Cap',
              code: 'WEEKLY_LIMIT_EXCEEDED',
              message: 'Projected weekly spend 1050 exceeds limit 1000',
            },
          ],
          evaluatedPolicyIds: ['policy-2'],
        });

        // 950 + 100 = 1050 > 1000
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);
      });
    });

    describe('limit exceeded — monthly', () => {
      it('throws PolicyViolationException when monthly limit would be exceeded', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { monthlyLimit: 5000 } },
        ]);
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(100) } },
          { _sum: { amount: makeDecimal(500) } },
          { _sum: { amount: makeDecimal(4950) } },  // 4950 this month
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-3',
              policyName: 'Monthly Spend Cap',
              code: 'MONTHLY_LIMIT_EXCEEDED',
              message: 'Projected monthly spend 5050 exceeds limit 5000',
            },
          ],
          evaluatedPolicyIds: ['policy-3'],
        });

        // 4950 + 100 = 5050 > 5000
        await expect(
          service.evaluateSpendingLimits(makeIntent({ amount: 100 }), 'user-1'),
        ).rejects.toThrow(PolicyViolationException);
      });
    });

    describe('missing policy scenario', () => {
      it('is a no-op and does not throw when no spending policies are configured', async () => {
        // Returns no policies at all
        mockPrismaService.policy.findMany.mockResolvedValue([]);

        await expect(
          service.evaluateSpendingLimits(makeIntent(), 'user-1'),
        ).resolves.toBeUndefined();

        expect(mockPolicyService.evaluateIntent).not.toHaveBeenCalled();
        expect(mockAuditService.record).not.toHaveBeenCalled();
      });

      it('is a no-op when only non-periodic policies exist (maxAmount, blockedAssets)', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { maxAmount: 1000, blockedAssets: ['BTC'] } },
          { configuration: { allowedRecipients: [VALID_STELLAR] } },
        ]);

        await expect(
          service.evaluateSpendingLimits(makeIntent(), 'user-1'),
        ).resolves.toBeUndefined();

        expect(mockPolicyService.evaluateIntent).not.toHaveBeenCalled();
      });
    });

    describe('intent enrichment', () => {
      it('passes enriched intent (with aggregates) to PolicyService.evaluateIntent', async () => {        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { dailyLimit: 1000, weeklyLimit: 5000, monthlyLimit: 15000 } },
        ]);
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(200) } },
          { _sum: { amount: makeDecimal(1200) } },
          { _sum: { amount: makeDecimal(3500) } },
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
          evaluatedPolicyIds: ['policy-1'],
        });

        await service.evaluateSpendingLimits(makeIntent({ amount: 50 }), 'user-1');

        const enrichedIntent = mockPolicyService.evaluateIntent.mock.calls[0][0] as TransactionIntent;
        expect(enrichedIntent.spentToday).toBe(200);
        expect(enrichedIntent.spentThisWeek).toBe(1200);
        expect(enrichedIntent.spentThisMonth).toBe(3500);
        expect(enrichedIntent.amount).toBe(50);
        expect(enrichedIntent.agentId).toBe('agent-1');
        expect(enrichedIntent.organizationId).toBe('org-1');
      });

      it('preserves original intent fields (asset, recipientAddress, walletId)', async () => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { dailyLimit: 1000 } },
        ]);
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(0) } },
          { _sum: { amount: makeDecimal(0) } },
          { _sum: { amount: makeDecimal(0) } },
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
          evaluatedPolicyIds: ['policy-1'],
        });

        const intent = makeIntent({ asset: 'XLM', walletId: 'wallet-42' });
        await service.evaluateSpendingLimits(intent, 'user-1');

        const passedIntent = mockPolicyService.evaluateIntent.mock.calls[0][0] as TransactionIntent;
        expect(passedIntent.asset).toBe('XLM');
        expect(passedIntent.walletId).toBe('wallet-42');
        expect(passedIntent.recipientAddress).toBe(VALID_STELLAR);
      });
    });

    describe('multi-asset transfers', () => {
      beforeEach(() => {
        mockPrismaService.policy.findMany.mockResolvedValue([
          { configuration: { assetLimits: { USDC: { dailyLimit: 500 } } } },
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: true,
          requiresApproval: false,
          violations: [],
          evaluatedPolicyIds: ['policy-1'],
        });
      });

      it('collects the spend of every asset in the payload', async () => {
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(0) } },
          { _sum: { amount: makeDecimal(0) } },
          { _sum: { amount: makeDecimal(0) } },
        ]);

        const intent = makeIntent({
          transfers: [
            { asset: 'XLM', amount: 10 },
            { asset: 'USDC', amount: 100 },
          ],
        });
        await service.evaluateSpendingLimits(intent, 'user-1');

        const passedIntent = mockPolicyService.evaluateIntent.mock.calls[0][0] as TransactionIntent;
        expect(passedIntent.spentByAsset).toBeDefined();
        expect(Object.keys(passedIntent.spentByAsset ?? {})).toEqual(['XLM', 'USDC']);
      });

      it('does not query the aggregates twice when they are already present', async () => {
        const intent = makeIntent({
          spentToday: 10,
          spentThisWeek: 10,
          spentThisMonth: 10,
          spentByAsset: {
            XLM: { spentToday: 10, spentThisWeek: 10, spentThisMonth: 10 },
            USDC: { spentToday: 0, spentThisWeek: 0, spentThisMonth: 0 },
          },
          transfers: [
            { asset: 'XLM', amount: 10 },
            { asset: 'USDC', amount: 100 },
          ],
        });
        await service.evaluateSpendingLimits(intent, 'user-1');

        const passedIntent = mockPolicyService.evaluateIntent.mock.calls[0][0] as TransactionIntent;
        expect(passedIntent.spentByAsset?.USDC.spentToday).toBe(0);
        expect(mockPrismaService.$transaction).not.toHaveBeenCalled();
      });

      it('reports the offending asset in the violation details', async () => {
        mockPrismaService.$transaction.mockResolvedValue([
          { _sum: { amount: makeDecimal(0) } },
          { _sum: { amount: makeDecimal(0) } },
          { _sum: { amount: makeDecimal(0) } },
        ]);
        mockPolicyService.evaluateIntent.mockResolvedValue({
          passed: false,
          requiresApproval: false,
          violations: [
            {
              policyId: 'policy-1',
              policyName: 'USDC cap',
              code: 'DAILY_LIMIT_EXCEEDED',
              message: 'Projected daily spend 600 USDC exceeds limit 500 USDC',
              asset: 'USDC',
            },
          ],
          evaluatedPolicyIds: ['policy-1'],
        });

        const intent = makeIntent({
          transfers: [
            { asset: 'XLM', amount: 10 },
            { asset: 'USDC', amount: 100 },
          ],
        });

        let caught: PolicyViolationException | undefined;
        try {
          await service.evaluateSpendingLimits(intent, 'user-1');
        } catch (error) {
          caught = error as PolicyViolationException;
        }

        expect(caught).toBeInstanceOf(PolicyViolationException);
        const details = caught?.details as { violations: Array<{ asset?: string }> };
        expect(details.violations[0].asset).toBe('USDC');

        const auditCall = mockAuditService.record.mock.calls[0][0] as Record<string, unknown>;
        const newValue = auditCall.newValue as Record<string, unknown>;
        expect(newValue.transfers).toEqual([
          { asset: 'XLM', amount: 10 },
          { asset: 'USDC', amount: 100 },
        ]);
      });
    });
  });

  // ── withSpendEnforcementLock ─────────────────────────────────────────────

  describe('withSpendEnforcementLock', () => {
    it('acquires an agent-scoped lock and runs the operation inside it', async () => {
      const result = await service.withSpendEnforcementLock('agent-1', async () => 'done');

      expect(mockRedisLock.withLock).toHaveBeenCalledWith(
        'agent-spending:agent-1',
        expect.any(Function),
      );
      expect(result).toBe('done');
    });

    it('propagates the operation result through the lock', async () => {
      const value = { ok: true };
      const result = await service.withSpendEnforcementLock('agent-1', async () => value);
      expect(result).toBe(value);
    });
  });

  // ── concurrency ──────────────────────────────────────────────────────────

  describe('concurrency — rolling-window budget', () => {
    /**
     * Two concurrent agent transactions, each under the per-transaction cap but
     * together over the daily limit, must not both succeed. The lock serialises
     * the check-then-reserve critical section; because the just-created spend row
     * is counted by the aggregate, the second serialised check sees it and is
     * denied.
     *
     * The in-memory `committed` counter stands in for the transaction row the
     * caller creates inside the locked operation (the real row is counted by the
     * aggregate because DRAFT is no longer excluded). The aggregate mock reads
     * the counter; `evaluateSpendingLimits` enforces the limit against it; the
     * operation "reserves" by incrementing it.
     */
    it('lets only one of two parallel over-limit transactions succeed', async () => {
      const limit = 100;
      const perRequest = 60; // each alone < limit, but 60 + 60 = 120 > 100

      // Shared committed-spend counter, simulating the transaction ledger.
      let committed = 0;

      // Serialising lock: run one operation fully before the next.
      let chain: Promise<unknown> = Promise.resolve();
      mockRedisLock.withLock.mockImplementation((_key: string, fn: () => Promise<unknown>) => {
        const run = chain.then(() => fn());
        chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      });

      // The aggregate returns the in-window committed spend.
      mockPrismaService.$transaction.mockImplementation(async (queries: unknown[]) => {
        // Resolve the aggregate promises so their side-effects (recording the
        // mocked committed spend) run, then return the three-window result.
        await Promise.all(queries as Array<Promise<unknown>>);
        return [
          { _sum: { amount: makeDecimal(committed) } },
          { _sum: { amount: makeDecimal(committed) } },
          { _sum: { amount: makeDecimal(committed) } },
        ];
      });
      // aggregate() calls resolve synchronously; make the per-query aggregate
      // return a resolved promise so `$transaction`'s Promise.all resolves.
      mockPrismaService.transaction.aggregate.mockImplementation(() =>
        Promise.resolve({ _sum: { amount: makeDecimal(committed) } }),
      );

      // The engine's periodic check, faithfully: deny when committed + amount > limit.
      mockPolicyService.evaluateIntent.mockImplementation((intent: TransactionIntent) => {
        const projected = (intent.spentToday ?? 0) + intent.amount;
        const passed = projected <= limit;
        return Promise.resolve({
          passed,
          requiresApproval: false,
          violations: passed
            ? []
            : [
                {
                  policyId: 'p1',
                  policyName: 'Daily Cap',
                  code: 'DAILY_LIMIT_EXCEEDED',
                  message: `Projected daily spend ${projected} exceeds the daily limit ${limit}; remaining daily allowance ${Math.max(0, limit - (intent.spentToday ?? 0))}`,
                },
              ],
          evaluatedPolicyIds: ['p1'],
          matchedPolicyId: 'p1',
        });
      });
      // A periodic limit policy is configured, so the aggregate path runs.
      mockPrismaService.policy.findMany.mockResolvedValue([{ configuration: { dailyLimit: limit } }]);

      // The locked critical section: check, then reserve (create the row).
      const attempt = async (): Promise<'allowed' | 'blocked'> => {
        try {
          await service.withSpendEnforcementLock('agent-1', async () => {
            const intent = makeIntent({ amount: perRequest });
            const aggregates = await service.aggregateSpend('agent-1', 'USDC');
            const enriched = {
              ...intent,
              spentToday: aggregates.spentToday,
              spentThisWeek: aggregates.spentThisWeek,
              spentThisMonth: aggregates.spentThisMonth,
            };
            await service.evaluateSpendingLimits(enriched, 'user-1');
            // Reserve: create the spend row (simulated by incrementing committed).
            committed += perRequest;
          });
          return 'allowed';
        } catch {
          return 'blocked';
        }
      };

      // Fire two truly-parallel attempts.
      const [first, second] = await Promise.all([attempt(), attempt()]);

      const allowed = [first, second].filter((r) => r === 'allowed').length;
      expect(allowed).toBe(1);
      // The first reserves 60; the second sees 60 committed, projects 120 > 100.
      expect(committed).toBe(60);
    });
  });
});
